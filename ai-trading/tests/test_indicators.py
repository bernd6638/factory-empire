import numpy as np
import pandas as pd
import pytest

from trading_system.analysis import indicators as ind
from conftest import make_bars


def test_sma_ema_basic():
    s = pd.Series(np.arange(1, 11, dtype=float))
    assert ind.sma(s, 3).iloc[-1] == pytest.approx(9.0)
    assert ind.sma(s, 3).isna().sum() == 2
    e = ind.ema(s, 3)
    # EMA mit alpha=0.5 auf 1..10 rekursiv nachrechnen
    v = 1.0
    for x in range(2, 11):
        v = 0.5 * x + 0.5 * v
    assert e.iloc[-1] == pytest.approx(v)


def test_rsi_bounds_and_extremes():
    up = pd.Series(np.arange(1, 50, dtype=float))
    assert ind.rsi(up, 14).iloc[-1] == pytest.approx(100.0)
    down = pd.Series(np.arange(50, 1, -1, dtype=float))
    assert ind.rsi(down, 14).iloc[-1] == pytest.approx(0.0)
    flat = pd.Series(np.full(40, 10.0))
    assert ind.rsi(flat, 14).iloc[-1] == pytest.approx(50.0)
    rnd = pd.Series(100 + np.random.default_rng(0).normal(0, 1, 300).cumsum())
    r = ind.rsi(rnd).dropna()
    assert ((r >= 0) & (r <= 100)).all()


def test_rsi_wilder_reference():
    # Klassisches Wilder-Beispiel mit SMA-Seed
    closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
              46.00, 46.03, 46.41, 46.22, 45.64]
    r = ind.rsi(pd.Series(closes), 14)
    # Referenz (StockCharts, ungerundete Kurse): 70.53, 66.32, 66.55, 69.41 – Rundung der Eingaben erklärt ±0.1
    assert r.iloc[14:18].tolist() == pytest.approx([70.53, 66.32, 66.55, 69.41], abs=0.15)
    assert r.iloc[:14].isna().all()


def test_macd_relationship():
    s = pd.Series(100 + np.random.default_rng(2).normal(0, 1, 200).cumsum())
    m = ind.macd(s)
    assert m["macd"].iloc[:25].isna().all()
    np.testing.assert_allclose(m["hist"].dropna(), (m["macd"] - m["signal"]).dropna())


def test_bollinger_contains_mid():
    s = pd.Series(100 + np.random.default_rng(3).normal(0, 1, 200).cumsum())
    bb = ind.bollinger(s).dropna()
    assert (bb["upper"] >= bb["mid"]).all() and (bb["lower"] <= bb["mid"]).all()
    assert ((bb["width"]) >= 0).all()


def test_atr_adx_and_no_lookahead(trend_bars):
    full = ind.add_all(trend_bars)
    part = ind.add_all(trend_bars.iloc[:300])
    cols = ["ema_21", "rsi_14", "macd_hist", "atr_14", "adx_14", "bb_upper"]
    # Werte an Kerze 299 dürfen nicht von späteren Daten abhängen
    pd.testing.assert_series_equal(full[cols].iloc[299], part[cols].iloc[-1], check_names=False)
    assert full["adx_14"].dropna().between(0, 100).all()
    assert (full["atr_14"].dropna() > 0).all()


def test_vwap_resets_daily():
    df = make_bars(np.linspace(100, 110, 200), freq="5min")
    v = ind.vwap(df)
    first_of_day = df.index.normalize() != np.roll(df.index.normalize(), 1)
    tp = (df["high"] + df["low"] + df["close"]) / 3
    assert v[first_of_day].round(8).equals(tp[first_of_day].round(8))
