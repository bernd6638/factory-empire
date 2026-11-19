import numpy as np
import pandas as pd
import pytest

from trading_system.ai.engine import AIEngine, DecisionJournal
from trading_system.analysis.indicators import add_all
from trading_system.analysis.market import analyze, detect_anomalies, higher_tf_trend_series
from trading_system.data.base import resample
from trading_system.errors import InsufficientDataError
from trading_system.strategies import Breakout, MeanReversion, MLStrategy, TrendFollowing
from conftest import make_bars


def test_analyze_uptrend(trend_bars):
    a, ind = analyze("TEST", trend_bars, "5m", {"15m": resample(trend_bars, "15m")})
    assert a.trend == "up"
    assert 0 <= a.trend_strength <= 1
    assert a.mtf_alignment > 0
    assert "Aufwärtstrend" in a.summary
    assert len(ind) == len(trend_bars)


def test_analyze_requires_data():
    with pytest.raises(InsufficientDataError):
        analyze("X", make_bars(np.linspace(1, 2, 30)), "5m")


def test_anomaly_detection_price_shock_and_volume():
    rng = np.random.default_rng(5)
    close = 100 * np.exp(np.cumsum(rng.normal(0, 0.001, 200)))
    close[-1] = close[-2] * 1.05
    df = make_bars(close)
    df.iloc[-1, df.columns.get_loc("volume")] = 50_000
    kinds = {x.kind for x in detect_anomalies(add_all(df))}
    assert {"price_shock", "volume_spike"} <= kinds


def test_strategy_scores_in_range(trend_bars):
    ind = add_all(trend_bars)
    for strat in (TrendFollowing(), MeanReversion(), Breakout(), MLStrategy()):
        s = strat.score_series(ind).dropna()
        assert len(s) > 0, strat.name
        assert s.between(-1, 1).all(), strat.name
        sig = strat.generate(ind)
        assert sig.action in {"BUY", "SELL", "HOLD"} and sig.reasons


def test_trend_following_positive_in_uptrend(trend_bars):
    assert TrendFollowing().score_series(add_all(trend_bars)).iloc[-50:].mean() > 0.3


def test_mean_reversion_buys_oversold():
    rng = np.random.default_rng(9)
    close = 100 + rng.normal(0, 0.2, 300)
    close[-6:] = close[-7] * np.array([0.995, 0.99, 0.985, 0.98, 0.975, 0.97])
    assert MeanReversion().score_series(add_all(make_bars(close, spread=0.0005))).iloc[-1] > 0.3


def test_ml_strategy_no_lookahead(trend_bars):
    ind = add_all(trend_bars)
    full = MLStrategy().score_series(ind)
    part = MLStrategy().score_series(ind.iloc[:320])
    assert full.iloc[319] == pytest.approx(part.iloc[-1])


def test_higher_tf_series_causal(trend_bars):
    full = higher_tf_trend_series(trend_bars, "15m")
    part = higher_tf_trend_series(trend_bars.iloc[:350], "15m")
    assert full.iloc[349] == part.iloc[-1]


def test_engine_decision_is_explained(trend_bars, tmp_path):
    a, ind = analyze("TEST", trend_bars, "5m")
    d = AIEngine().decide("TEST", ind, a)
    assert d.action in {"BUY", "SELL", "HOLD"}
    assert abs(sum(e.weight for e in d.evaluations) - 1) < 1e-3
    assert d.reasons and d.disclaimer and "Gewinnzusage" in d.disclaimer
    if d.action == "BUY":
        assert d.risk.stop_loss < d.price < d.risk.take_profit
    j = DecisionJournal(tmp_path / "j.jsonl")
    j.write(d)
    assert j.tail(1)[0]["id"] == d.id


def test_engine_survives_broken_strategy(trend_bars):
    class Broken(TrendFollowing):
        name = "broken"

        def score_series(self, ind):
            raise RuntimeError("kaputt")

    a, ind = analyze("TEST", trend_bars, "5m")
    d = AIEngine([Broken(), TrendFollowing()]).decide("TEST", ind, a)
    broken = next(s for s in d.signals if s.strategy == "broken")
    assert broken.score == 0 and "Fehler" in broken.reasons[0]


def test_engine_weights_favor_predictive_strategy():
    from trading_system.strategies.base import Strategy

    class Oracle(Strategy):
        name = "oracle"

        def score_series(self, ind):  # bewusst mit Zukunftswissen – nur für den Gewichtungstest
            return np.sign(ind["close"].shift(-6) - ind["close"]).fillna(0)

        def explain(self, row, score):
            return ["oracle"]

    class Noise(Oracle):
        name = "noise"

        def score_series(self, ind):
            return pd.Series(np.random.default_rng(0).uniform(-1, 1, len(ind)), index=ind.index)

    rng = np.random.default_rng(4)
    df = make_bars(100 * np.exp(np.cumsum(rng.normal(0, 0.002, 500))))
    ind = add_all(df)
    eng = AIEngine([Oracle(), Noise()])
    evals = eng.evaluate_strategies(ind, {s.name: s.score_series(ind) for s in eng.strategies})
    w = {e.strategy: e.weight for e in evals}
    assert w["oracle"] > 0.8 > w["noise"]
