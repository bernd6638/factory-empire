# Architektur

```
trading_system/
├── config.py            Einstellungen, Paper-Zwang, .env-Loader
├── secret_store.py      Verschlüsselter Schlüsseltresor, Maskierung
├── errors.py            Fehlerhierarchie
├── data/
│   ├── base.py          Provider-Schnittstelle, Validierung, Resampling, Cache, Fallback + Circuit-Breaker
│   ├── providers.py     Alpaca, Alpha Vantage, Yahoo (HTTP mit Retry/Backoff), build_provider()
│   └── simulated.py     Deterministischer Marktsimulator (Regime, Fat Tails, Sprünge, Volumenprofil)
├── analysis/
│   ├── indicators.py    RSI, MACD, EMA, SMA, Bollinger, ATR, ADX, VWAP, Volatilität, z-Score
│   └── market.py        Trend, Volatilitätsregime, Anomalien, Multi-Timeframe, Zusammenfassung
├── strategies/
│   ├── base.py          Strategy-Interface, Signal
│   ├── rules.py         TrendFollowing, MeanReversion, Breakout
│   └── ml.py            Walk-forward logistische Regression
├── ai/
│   ├── engine.py        AIEngine (Strategievergleich, Ensemble, Konfidenz, Risiko), DecisionJournal
│   └── llm_analyst.py   Optionaler Claude-Kommentar (beeinflusst keine Entscheidung)
├── trading/
│   ├── broker.py        PaperBroker (Orders, SL/TP, Equity, Persistenz)
│   ├── costs.py         Kommission + Slippage
│   ├── risk.py          Positionsgröße, Kill-Switches
│   ├── ledger.py        SQLite-Protokoll
│   └── metrics.py       Sharpe, Sortino, Drawdown, VaR/CVaR, Trefferquote, Profit-Faktor …
├── backtest/backtester.py   Ereignisgetriebener Backtest + Strategievergleich
├── bot.py               Autonomer Zyklus + Hintergrund-Thread
├── api/server.py        FastAPI-REST-API
├── dashboard/           index.html + mitgelieferte Chart-Bibliothek
└── __main__.py          CLI
```

## Datenfluss eines Zyklus

```
Provider ──► Kerzen (5m) + höhere Zeitebenen (15m, 1h)
   │
   ├─► PaperBroker.on_bar()        neue Kerzen gegen Stop-Loss / Take-Profit prüfen
   │
   ├─► analysis.analyze()          Indikatoren, Trend, Regime, Anomalien, MTF-Übereinstimmung
   │
   ├─► AIEngine.decide()
   │      1. Score-Serie je Strategie (−1 … +1)
   │      2. Strategievergleich: Spearman-IC der Scores vs. Rendite der nächsten 6 Kerzen
   │         (nur bereits bekannte Zukunft) → Softmax-Gewichte, Untergrenze, negative IC gedämpft
   │      3. Ensemble-Score = Σ Gewicht × Score
   │      4. Konfidenz = Signalstärke + gewichtete Übereinstimmung ± MTF ± Volatilität ± Anomalien
   │      5. Risiko: SL = Preis − 2·ATR, TP = Preis + 2·(Preis − SL), Risiko-Score
   │      6. BUY/SELL nur bei |Score| ≥ 0,25 und Konfidenz ≥ min_confidence, sonst HOLD
   │
   ├─► DecisionJournal (JSONL)     vollständige Entscheidung inkl. aller Begründungen
   │
   └─► Ausführung (simuliert)
          RiskManager.can_open()    Tagesverlust, Drawdown, Anzahl Positionen
          RiskManager.position_size()
             Risiko = Equity × 1 % × (0,5 + 0,5 × Konfidenz)
             Stück  = Risiko / |Einstieg − Stop|, begrenzt durch 20 % Positionsgröße,
                      Exposure-Budget (kein Hebel) und Bargeld
          PaperBroker.open_position() Ausführung ± Slippage, Kommission, Transaktion protokolliert
```

## Ausführungsmodell

- Marktorders zum Referenzpreis ± `slippage_bps` (adverse Richtung), Kommission je Aktie mit Mindestgebühr.
- Stop-Loss/Take-Profit werden mit High/Low jeder Kerze geprüft. Liegt der Open jenseits des Levels,
  wird zum Open ausgeführt (Gap). Werden SL und TP in derselben Kerze berührt, wird der Stop
  angenommen (konservativ).
- Im Backtest werden Signale der Kerze *t* erst zum Open der Kerze *t+1* ausgeführt.

## Vermeidung von Look-Ahead-Bias

- Alle Indikatoren sind kausal (Tests prüfen, dass Werte bei *t* nicht von späteren Daten abhängen).
- Höhere Zeitebenen werden mit ihrem Endzeitpunkt beschriftet und erst danach verwendet.
- Das ML-Modell trainiert für Kerze *t* nur auf Beispielen, deren Ziel bei *t* bekannt war.
- Die Strategiegewichte nutzen nur Rendite-Fenster, die vollständig in der Vergangenheit liegen.

## Fehlerbehandlung

| Ebene | Verhalten |
|---|---|
| HTTP | Retry mit Backoff bei 429/5xx/Netzwerkfehlern; 401/403 sofortige, klare Meldung |
| Anbieter | Fallback-Kette, Circuit-Breaker (5 Min.), Simulator als letzte Stufe |
| Daten | Validierung (Spalten, NaN, High ≥ Low, Duplikate, Zeitzone) |
| Strategie | Ausnahme einer Strategie → Score 0 mit Fehlerhinweis, die übrigen laufen weiter |
| Symbol | Fehler werden pro Symbol isoliert und im Dashboard angezeigt |
| Bot-Schleife | exponentielles Backoff bis 10 Min. bei wiederholten Fehlern |
| Orders | `OrderRejectedError` bei ungültigen Levels, fehlendem Kapital, Doppelpositionen |
| LLM | jeder Fehler wird abgefangen; Handel läuft ohne Kommentar weiter |

## Erweiterung

**Neue Strategie:** Klasse von `Strategy` ableiten, `score_series()` (kausal, Werte in [−1, 1]) und
`explain()` implementieren, in `strategies/__init__.py::default_strategies()` eintragen. Die Engine
bewertet und gewichtet sie automatisch.

**Neuer Datenanbieter:** `MarketDataProvider.get_bars()` implementieren (DataFrame mit
`open, high, low, close, volume`, UTC-Index, über `validate_bars()` geben) und in
`providers.build_provider()` einreihen.

**Echter Broker:** bewusst **nicht** vorgesehen. Eine Anbindung wäre eine separate, ausdrücklich
freizugebende Entwicklung mit eigener Prüfung. Der Paper-Zwang in `config.enforce_paper()` und der
Sicherheitstest müssten dafür bewusst geändert werden.

## REST-API

| Methode | Pfad | Inhalt |
|---|---|---|
| GET | `/api/status` | Modus, Laufstatus, Datenquelle, Zugangsdaten-Status |
| GET | `/api/portfolio` | Equity, Cash, Exposure, Positionen |
| GET | `/api/performance` | Equity- und Trade-Kennzahlen |
| GET | `/api/equity` | Equity-Kurve |
| GET | `/api/transactions`, `/api/trades` | Transaktionsprotokoll, abgeschlossene Trades |
| GET | `/api/signals`, `/api/analysis[/{sym}]` | aktuelle Entscheidungen und Analysen |
| GET | `/api/bars/{sym}` | Kerzen + Indikatoren + Marker für die Charts |
| GET | `/api/journal`, `/api/events` | Entscheidungsjournal, Ereignisse und Fehler |
| POST | `/api/control/start` · `stop` · `step` · `close-all` | Steuerung (nur Simulation) |
