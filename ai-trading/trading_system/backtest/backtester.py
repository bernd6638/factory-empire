"""Backtester und Strategievergleich.

Nutzt dieselbe KI-Engine, denselben Paper-Broker, dasselbe Risiko- und
Kostenmodell wie der Live-Paper-Betrieb. Alle Scores sind kausal; die
Ausführung erfolgt zum Eröffnungskurs der FOLGEKERZE (kein Look-Ahead).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from ..ai.engine import AIEngine
from ..analysis.indicators import add_all
from ..analysis.market import analysis_from_indicators, higher_tf_trend_series
from ..config import Settings
from ..strategies import Strategy, default_strategies
from ..trading.broker import PaperBroker
from ..trading.costs import CostModel
from ..trading.ledger import Ledger
from ..trading.metrics import equity_metrics, trade_metrics
from ..trading.risk import RiskManager

WARMUP = 210


@dataclass
class BacktestResult:
    name: str
    metrics: dict
    trade_stats: dict
    equity: pd.Series
    trades: list[dict] = field(default_factory=list)

    def summary(self) -> dict:
        return {"name": self.name, **self.metrics, **self.trade_stats}


class Backtester:
    def __init__(self, settings: Settings, reweight_every: int = 20):
        self.s = settings
        self.reweight_every = reweight_every

    def run(self, data: dict[str, pd.DataFrame], strategies: list[Strategy] | None = None,
            name: str = "ensemble", periods_per_year: float = 252 * 78) -> BacktestResult:
        s = self.s
        engine = AIEngine(strategies or default_strategies(), min_confidence=s.min_confidence,
                          atr_stop_mult=s.risk.atr_stop_mult, reward_risk=s.risk.reward_risk)
        broker = PaperBroker(s.initial_capital, CostModel(s.costs), Ledger(":memory:"), allow_short=s.risk.allow_short)
        risk = RiskManager(s.risk)

        prepared = {}
        for sym, df in data.items():
            if len(df) <= WARMUP + 10:
                continue
            ind = add_all(df)
            scores, _ = engine.compute_scores(ind)
            mtf = [higher_tf_trend_series(df, tf) for tf in s.confirm_timeframes]
            mtf_series = (sum(mtf) + 0) / max(1, len(mtf)) if mtf else pd.Series(0.0, index=df.index)
            prepared[sym] = (df, ind, scores, mtf_series)
        if not prepared:
            raise ValueError("Zu wenige Daten für einen Backtest")

        timeline = sorted(set().union(*[p[0].index for p in prepared.values()]))
        pos_of = {sym: {ts: i for i, ts in enumerate(p[0].index)} for sym, p in prepared.items()}
        evals_cache: dict[str, tuple[int, list]] = {}
        pending: dict[str, object] = {}   # Entscheidung von Kerze t -> Ausführung bei Open t+1

        for ts in timeline:
            ts_s = str(ts)
            prices = {}
            for sym, (df, ind, scores, mtf_series) in prepared.items():
                i = pos_of[sym].get(ts)
                if i is None:
                    continue
                bar = df.iloc[i]
                prices[sym] = float(bar["close"])
                # 1) ausstehende Entscheidung zum Open ausführen
                dec = pending.pop(sym, None)
                if dec is not None:
                    self._execute(broker, risk, dec, float(bar["open"]), ts_s)
                # 2) SL/TP innerhalb der Kerze prüfen
                broker.on_bar(sym, ts_s, float(bar["open"]), float(bar["high"]), float(bar["low"]), float(bar["close"]))
                if i < WARMUP:
                    continue
                # 3) Entscheidung auf Basis der geschlossenen Kerze
                sub = ind.iloc[: i + 1]
                sub_scores = {k: v.iloc[: i + 1] for k, v in scores.items()}
                last_eval = evals_cache.get(sym)
                if last_eval is None or i - last_eval[0] >= self.reweight_every:
                    evals_cache[sym] = (i, engine.evaluate_strategies(sub, sub_scores))
                analysis = analysis_from_indicators(sym, sub, s.timeframe, float(mtf_series.iloc[i]))
                d = engine.decide(sym, sub, analysis, scores=sub_scores, evals=evals_cache[sym][1], explain=False)
                if d.action != "HOLD":
                    pending[sym] = d
            broker.mark(prices, ts_s, record=True)

        for sym in list(broker.positions):
            df = prepared[sym][0]
            broker.close_position(sym, float(df["close"].iloc[-1]), str(df.index[-1]), "Backtest-Ende")
        broker.mark({}, str(timeline[-1]), record=True)
        eq = pd.Series({pd.Timestamp(r["ts"]): r["equity"] for r in broker.ledger.equity_curve(10**7)})
        trades = list(reversed(broker.ledger.trades(10**6)))
        return BacktestResult(name, equity_metrics(eq, periods_per_year), trade_metrics(trades), eq, trades)

    @staticmethod
    def _execute(broker: PaperBroker, risk: RiskManager, d, open_price: float, ts: str) -> None:
        sym = d.symbol
        pos = broker.positions.get(sym)
        if d.action == "SELL" and pos and pos.side == "LONG":
            broker.close_position(sym, open_price, ts, "Verkaufssignal")
            return
        if d.action == "BUY" and pos and pos.side == "SHORT":
            broker.close_position(sym, open_price, ts, "Kaufsignal")
            return
        if pos:
            return
        side = "LONG" if d.action == "BUY" else "SHORT"
        if side == "SHORT" and not broker.allow_short:
            return
        ok, _ = risk.can_open(len(broker.positions), broker.day_pnl_pct(ts[:10]), broker.drawdown())
        if not ok:
            return
        dist = abs(d.price - d.risk.stop_loss)
        stop = open_price - dist if side == "LONG" else open_price + dist
        take = open_price + dist * d.risk.reward_risk if side == "LONG" else open_price - dist * d.risk.reward_risk
        est_fill = broker.costs.fill_price("BUY" if side == "LONG" else "SELL", open_price)
        size = risk.position_size(broker.equity, broker.cash, est_fill, stop, broker.exposure, d.confidence)
        if size.qty > 0:
            broker.open_position(sym, side, size.qty, open_price, ts, stop, take, d.id, "KI-Signal")

    def compare(self, data: dict[str, pd.DataFrame], periods_per_year: float = 252 * 78) -> list[dict]:
        """Vergleicht jede Einzelstrategie mit dem adaptiven Ensemble und Buy-and-Hold."""
        results = []
        for strat in default_strategies():
            results.append(self.run(data, [strat], strat.name, periods_per_year).summary())
        results.append(self.run(data, None, "ki_ensemble", periods_per_year).summary())
        bh = [df["close"] / df["close"].iloc[0] for df in data.values()]
        bh_eq = pd.concat(bh, axis=1).ffill().mean(axis=1) * self.s.initial_capital
        results.append({"name": "buy_and_hold", **equity_metrics(bh_eq, periods_per_year), "trades": 0})
        return results
