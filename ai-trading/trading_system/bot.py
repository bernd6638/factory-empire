"""Autonomer Paper-Trading-Bot.

Pro Zyklus und Symbol: Daten laden -> SL/TP prüfen -> analysieren ->
KI-Entscheidung -> (simulierte) Ausführung -> protokollieren.
Fehler bei einem Symbol stoppen niemals den gesamten Zyklus.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from datetime import datetime, timezone

import pandas as pd

from .ai.engine import AIEngine, Decision, DecisionJournal
from .ai.llm_analyst import LLMAnalyst
from .analysis.market import MarketAnalysis, analyze
from .config import Settings, enforce_paper
from .data.base import MarketDataProvider
from .data.providers import build_provider
from .errors import OrderRejectedError, TradingSystemError
from .secret_store import get_secret
from .trading.broker import PaperBroker
from .trading.costs import CostModel
from .trading.ledger import Ledger
from .trading.metrics import equity_metrics, trade_metrics
from .trading.risk import RiskManager

log = logging.getLogger(__name__)


class TradingBot:
    def __init__(self, settings: Settings, provider: MarketDataProvider | None = None,
                 ledger: Ledger | None = None, llm: LLMAnalyst | None = None):
        enforce_paper(settings.trading_mode)
        self.s = settings
        self.provider = provider or build_provider(settings, lambda n: get_secret(n, settings.vault_path))
        self.ledger = ledger or Ledger(settings.db_path)
        self.broker = PaperBroker(settings.initial_capital, CostModel(settings.costs), self.ledger,
                                  allow_short=settings.risk.allow_short)
        self.risk = RiskManager(settings.risk)
        self.engine = AIEngine(min_confidence=settings.min_confidence, atr_stop_mult=settings.risk.atr_stop_mult,
                               reward_risk=settings.risk.reward_risk)
        self.journal = DecisionJournal(settings.journal_path)
        if llm is None:
            key = get_secret("ANTHROPIC_API_KEY", settings.vault_path) if settings.llm_enabled else None
            llm = LLMAnalyst(key, settings.llm_model, settings.llm_effort)
        self.llm = llm
        self.analyses: dict[str, MarketAnalysis] = {}
        self.decisions: dict[str, Decision] = {}
        self.bars: dict[str, pd.DataFrame] = {}
        self.last_bar_ts: dict[str, str] = self.ledger.load_state("last_bar_ts", {}) or {}
        self.events: deque[dict] = deque(maxlen=300)
        self.errors: deque[dict] = deque(maxlen=100)
        self.cycles = 0
        self.last_cycle: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.RLock()

    # ---------- Hilfen ----------
    def _event(self, kind: str, msg: str, **extra) -> None:
        e = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "kind": kind, "message": msg, **extra}
        self.events.appendleft(e)
        log.info("[%s] %s", kind, msg)

    def _error(self, symbol: str, exc: Exception) -> None:
        e = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "symbol": symbol,
             "error": f"{type(exc).__name__}: {exc}"[:400]}
        self.errors.appendleft(e)
        log.warning("Fehler bei %s: %s", symbol, e["error"])

    # ---------- Zyklus ----------
    def process_symbol(self, symbol: str) -> Decision:
        df = self.provider.get_bars(symbol, self.s.timeframe, self.s.lookback_bars)
        higher = {}
        for tf in self.s.confirm_timeframes:
            try:
                higher[tf] = self.provider.get_bars(symbol, tf, self.s.lookback_bars)
            except TradingSystemError as exc:
                self._error(symbol, exc)
        self.bars[symbol] = df

        # neue Kerzen seit dem letzten Zyklus gegen SL/TP prüfen
        last_seen = self.last_bar_ts.get(symbol)
        new_bars = df[df.index > pd.Timestamp(last_seen)] if last_seen else df.iloc[-1:]
        for ts, bar in new_bars.iterrows():
            closed = self.broker.on_bar(symbol, str(ts), bar["open"], bar["high"], bar["low"], bar["close"])
            if closed:
                self._event("exit", f"{symbol} geschlossen: {closed['exit_reason']} – PnL {closed['pnl']:+.2f}", trade=closed)
        self.last_bar_ts[symbol] = str(df.index[-1])

        analysis, ind = analyze(symbol, df, self.s.timeframe, higher)
        decision = self.engine.decide(symbol, ind, analysis)
        if self.llm and self.llm.enabled:
            decision.llm_commentary = self.llm.commentary(symbol, analysis.to_dict(), decision.to_dict())
        self.analyses[symbol] = analysis
        self.decisions[symbol] = decision
        self.journal.write(decision)
        self.execute(decision, str(df.index[-1]))
        return decision

    def execute(self, d: Decision, ts: str) -> None:
        sym, price = d.symbol, d.price
        pos = self.broker.positions.get(sym)
        try:
            if d.action == "SELL" and pos and pos.side == "LONG":
                t = self.broker.close_position(sym, price, ts, "Verkaufssignal der KI")
                self._event("exit", f"{sym} verkauft – PnL {t['pnl']:+.2f}", trade=t)
                return
            if d.action == "BUY" and pos and pos.side == "SHORT":
                t = self.broker.close_position(sym, price, ts, "Kaufsignal der KI")
                self._event("exit", f"{sym} Short eingedeckt – PnL {t['pnl']:+.2f}", trade=t)
                return
            if d.action == "HOLD" or pos:
                return
            side = "LONG" if d.action == "BUY" else "SHORT"
            if side == "SHORT" and not self.s.risk.allow_short:
                return
            ok, why = self.risk.can_open(len(self.broker.positions), self.broker.day_pnl_pct(ts[:10]),
                                         self.broker.drawdown())
            if not ok:
                self._event("risk", f"{sym}: Einstieg blockiert – {why}")
                return
            est_fill = self.broker.costs.fill_price("BUY" if side == "LONG" else "SELL", price)
            size = self.risk.position_size(self.broker.equity, self.broker.cash, est_fill, d.risk.stop_loss,
                                           self.broker.exposure, d.confidence)
            if size.qty <= 0:
                self._event("risk", f"{sym}: Positionsgröße 0 ({size.reason})")
                return
            p = self.broker.open_position(sym, side, size.qty, price, ts, d.risk.stop_loss, d.risk.take_profit,
                                          d.id, "KI-Signal")
            self._event("entry", f"{sym} {side} {size.qty} Stk. @ {p.entry_price:.2f} (SL {p.stop_loss:.2f}, "
                                 f"TP {p.take_profit:.2f}, {size.reason})")
        except OrderRejectedError as exc:
            self._event("rejected", f"{sym}: Order abgelehnt – {exc}")

    def run_cycle(self) -> dict:
        with self._lock:
            enforce_paper(self.s.trading_mode)
            done, failed = [], []
            for sym in self.s.symbols:
                try:
                    self.process_symbol(sym)
                    done.append(sym)
                except Exception as exc:  # noqa: BLE001 - Fehler pro Symbol isolieren
                    self._error(sym, exc)
                    failed.append(sym)
            now = datetime.now(timezone.utc).isoformat(timespec="seconds")
            prices = {s: a.price for s, a in self.analyses.items()}
            self.broker.mark(prices, now)
            self.ledger.save_state("last_bar_ts", self.last_bar_ts)
            self.cycles += 1
            self.last_cycle = now
            return {"ok": done, "failed": failed, "equity": round(self.broker.equity, 2)}

    # ---------- Hintergrundbetrieb ----------
    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="trading-bot", daemon=True)
        self._thread.start()
        self._event("system", "Autonomer Paper-Trading-Betrieb gestartet")

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)
        self._event("system", "Betrieb gestoppt")

    def _loop(self) -> None:
        backoff = self.s.loop_interval_sec
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                res = self.run_cycle()
                backoff = self.s.loop_interval_sec if res["ok"] else min(backoff * 2, 600)
            except Exception as exc:  # noqa: BLE001
                self._error("*", exc)
                backoff = min(backoff * 2, 600)
            self._stop.wait(max(1.0, backoff - (time.monotonic() - t0)))

    def close_all(self, reason: str = "Manuell geschlossen") -> list[dict]:
        out = []
        with self._lock:
            for sym in list(self.broker.positions):
                price = self.analyses[sym].price if sym in self.analyses else self.broker.positions[sym].last_price
                ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
                out.append(self.broker.close_position(sym, price, ts, reason))
        return out

    # ---------- Berichte ----------
    def performance(self) -> dict:
        curve = self.ledger.equity_curve()
        eq = pd.Series([r["equity"] for r in curve], index=pd.to_datetime([r["ts"] for r in curve], utc=True,
                                                                          format="mixed")) if curve else pd.Series(dtype=float)
        # Annualisierung anhand der Zyklusfrequenz schätzen
        ppy = 252 * 6.5 * 3600 / max(self.s.loop_interval_sec, 1)
        return {"equity": equity_metrics(eq, ppy), "trades": trade_metrics(self.ledger.trades())}
