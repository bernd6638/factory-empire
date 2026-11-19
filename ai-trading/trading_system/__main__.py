"""Kommandozeile: ``python -m trading_system <befehl>``.

Befehle:
  serve        Dashboard + API starten (http://127.0.0.1:8000)
  run          Autonomer Paper-Trading-Betrieb ohne Oberfläche
  step         Genau einen Analyse-/Handelszyklus ausführen
  analyze SYM  Marktanalyse + KI-Entscheidung für ein Symbol ausgeben
  backtest     Ensemble-Backtest auf historischen (oder simulierten) Daten
  compare      Strategievergleich (Einzelstrategien vs. Ensemble vs. Buy & Hold)
  status       Konfiguration, Integrationen und fehlende Zugangsdaten anzeigen
  vault        Verschlüsselten Schlüsseltresor verwalten (set/list/delete)
  reset        Paper-Konto zurücksetzen (löscht Protokoll und Positionen)
"""

from __future__ import annotations

import argparse
import getpass
import json
import logging
import os
import signal
import sys
import time

from .config import load_dotenv, load_settings
from .errors import TradingSystemError


def _bot(args):
    from .bot import TradingBot
    s = load_settings(args.config)
    if args.provider:
        s.data_provider = args.provider
    if args.symbols:
        s.symbols = [x.strip().upper() for x in args.symbols.split(",")]
    return TradingBot(s.validate())


def cmd_serve(args):
    import uvicorn
    from .api.server import create_app
    bot = _bot(args)
    if args.host not in ("127.0.0.1", "localhost"):
        print("WARNUNG: Die API hat keine Authentifizierung. Nur in vertrauenswürdigen Netzen freigeben.", file=sys.stderr)
    uvicorn.run(create_app(bot, autostart=args.autostart), host=args.host, port=args.port, log_level="info")


def cmd_run(args):
    bot = _bot(args)
    stop = {"flag": False}
    signal.signal(signal.SIGINT, lambda *_: stop.update(flag=True))
    signal.signal(signal.SIGTERM, lambda *_: stop.update(flag=True))
    print(f"Paper-Trading gestartet: {bot.s.symbols} @ {bot.s.timeframe}, Intervall {bot.s.loop_interval_sec}s. Strg+C beendet.")
    while not stop["flag"]:
        res = bot.run_cycle()
        print(json.dumps({"zyklus": bot.cycles, **res}, ensure_ascii=False))
        for _ in range(int(bot.s.loop_interval_sec)):
            if stop["flag"]:
                break
            time.sleep(1)
    print("Beendet.")


def cmd_step(args):
    bot = _bot(args)
    print(json.dumps(bot.run_cycle(), ensure_ascii=False, indent=2))
    for d in bot.decisions.values():
        print(f"{d.symbol:6} {d.action:4} score={d.ensemble_score:+.2f} konf={d.confidence:.0%}  {d.reasons[0]}")
    for e in list(bot.events)[:10]:
        print("  ·", e["message"])


def cmd_analyze(args):
    bot = _bot(args)
    sym = args.symbol.upper()
    from .analysis.market import analyze
    df = bot.provider.get_bars(sym, bot.s.timeframe, bot.s.lookback_bars)
    higher = {tf: bot.provider.get_bars(sym, tf, bot.s.lookback_bars) for tf in bot.s.confirm_timeframes}
    a, ind = analyze(sym, df, bot.s.timeframe, higher)
    d = bot.engine.decide(sym, ind, a)
    print(a.summary, "\n")
    print(f"Entscheidung: {d.action} (Score {d.ensemble_score:+.2f}, Konfidenz {d.confidence:.0%})")
    for r in d.reasons:
        print("  -", r)
    print("\nStrategien:")
    for e, s in zip(d.evaluations, d.signals):
        print(f"  {e.strategy:16} Gewicht {e.weight:5.1%}  IC {e.ic:+.3f}  Treffer {e.hit_rate:.0%}  Signal {s.action} {s.score:+.2f}")
    print(f"\nRisiko: SL {d.risk.stop_loss}  TP {d.risk.take_profit}  Risiko-Score {d.risk.risk_score:.0%}")
    print("\n" + d.disclaimer)


def _bt_data(args, bot):
    bars = args.bars
    return {s: bot.provider.get_bars(s, bot.s.timeframe, bars) for s in bot.s.symbols}


def cmd_backtest(args):
    from .backtest.backtester import Backtester
    bot = _bot(args)
    res = Backtester(bot.s).run(_bt_data(args, bot))
    print(json.dumps(res.summary(), indent=2, ensure_ascii=False))


def cmd_compare(args):
    from .backtest.backtester import Backtester
    bot = _bot(args)
    rows = Backtester(bot.s).compare(_bt_data(args, bot))
    hdr = f"{'Strategie':18}{'Rendite %':>11}{'Sharpe':>9}{'MaxDD %':>9}{'Trades':>8}{'Treffer %':>11}{'PF':>7}"
    print(hdr + "\n" + "-" * len(hdr))
    for r in rows:
        print(f"{r['name']:18}{r['total_return_pct']:>11.2f}{r['sharpe']:>9.2f}{r['max_drawdown_pct']:>9.2f}"
              f"{r.get('trades', 0):>8}{r.get('win_rate_pct', 0):>11.1f}{r.get('profit_factor', 0):>7.2f}")
    print("\nHinweis: Backtest-Ergebnisse sind keine Prognose zukünftiger Erträge.")


def cmd_status(args):
    from .secret_store import secrets_status
    s = load_settings(args.config)
    print(f"Modus: {s.trading_mode.upper()} (einzig erlaubter Modus)")
    print(f"Symbole: {', '.join(s.symbols)}  |  Intervall: {s.timeframe} (+{', '.join(s.confirm_timeframes)})")
    print(f"Datenanbieter: {s.data_provider}  |  Startkapital: {s.initial_capital:,.0f}")
    print("\nZugangsdaten:")
    for k, v in secrets_status(s.vault_path).items():
        print(f"  {k:22} {'✔ ' + v['masked'] if v['configured'] else '✘ fehlt':20} {v['description']}")


def cmd_vault(args):
    from .secret_store import KNOWN_SECRETS, SecretVault, mask
    s = load_settings(args.config)
    pw = os.environ.get("TS_VAULT_PASSWORD") or getpass.getpass("Tresor-Passwort: ")
    v = SecretVault(s.vault_path, pw)
    if args.action == "list":
        for n in v.names():
            print(f"{n:22} {mask(v.get(n))}")
    elif args.action == "set":
        if args.name not in KNOWN_SECRETS:
            print(f"Hinweis: {args.name} ist kein bekannter Schlüssel ({', '.join(KNOWN_SECRETS)})")
        v.set(args.name, getpass.getpass(f"Wert für {args.name} (Eingabe unsichtbar): "))
        print("Gespeichert. Zum Verwenden TS_VAULT_PASSWORD beim Start setzen.")
    elif args.action == "delete":
        print("Gelöscht." if v.delete(args.name) else "Nicht vorhanden.")


def cmd_reset(args):
    from .trading.ledger import Ledger
    s = load_settings(args.config)
    if not args.yes and input("Paper-Konto wirklich zurücksetzen? (ja/nein) ").strip().lower() != "ja":
        return
    Ledger(s.db_path).reset()
    print("Zurückgesetzt.")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="trading_system", description="Autonomes KI-Paper-Trading-System")
    p.add_argument("--config", help="Pfad zu config.json")
    p.add_argument("--provider", help="Datenanbieter überschreiben (simulated|yahoo|alpaca|alphavantage|auto)")
    p.add_argument("--symbols", help="Kommagetrennte Symbolliste überschreiben")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)
    sp = sub.add_parser("serve"); sp.add_argument("--host", default="127.0.0.1"); sp.add_argument("--port", type=int, default=8000)
    sp.add_argument("--autostart", action="store_true", help="Bot beim Start automatisch laufen lassen")
    sp.set_defaults(fn=cmd_serve)
    sub.add_parser("run").set_defaults(fn=cmd_run)
    sub.add_parser("step").set_defaults(fn=cmd_step)
    sp = sub.add_parser("analyze"); sp.add_argument("symbol"); sp.set_defaults(fn=cmd_analyze)
    for name, fn in (("backtest", cmd_backtest), ("compare", cmd_compare)):
        sp = sub.add_parser(name); sp.add_argument("--bars", type=int, default=2000); sp.set_defaults(fn=fn)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    sp = sub.add_parser("vault"); sp.add_argument("action", choices=["set", "list", "delete"]); sp.add_argument("name", nargs="?")
    sp.set_defaults(fn=cmd_vault)
    sp = sub.add_parser("reset"); sp.add_argument("--yes", action="store_true"); sp.set_defaults(fn=cmd_reset)
    args = p.parse_args(argv)
    load_dotenv()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if args.cmd == "vault" and args.action in ("set", "delete") and not args.name:
        p.error("vault set/delete benötigt einen Namen, z. B. ALPACA_API_KEY")
    try:
        args.fn(args)
    except TradingSystemError as exc:
        print(f"Fehler: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
