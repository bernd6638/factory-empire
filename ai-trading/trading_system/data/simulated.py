"""Synthetischer Marktdaten-Generator (offline, deterministisch).

Erzeugt realistisch wirkende Intraday-Kerzen mit Regimewechseln
(Trend/Seitwärts/Volatilitätsschübe), Volumenprofil und gelegentlichen
Sprüngen. Dient für Tests, Demos und als Fallback, wenn kein echter
Datenanbieter erreichbar ist. Die Daten sind NICHT real.
"""

from __future__ import annotations

import hashlib
import time

import numpy as np
import pandas as pd

from .base import MarketDataProvider, tf_minutes

BASE_PRICES = {"AAPL": 230.0, "MSFT": 450.0, "NVDA": 140.0, "SPY": 600.0, "QQQ": 520.0, "TSLA": 330.0, "AMZN": 210.0}


class SimulatedProvider(MarketDataProvider):
    name = "simulated"
    is_realtime = False

    def __init__(self, seed: int = 42, live: bool = True, history_minutes: int = 60 * 24 * 30):
        """``live=True``: die Serie wächst mit der Echtzeit (eine neue 1m-Kerze pro Minute)."""
        self.seed = seed
        self.live = live
        self.history_minutes = history_minutes
        self._anchor = pd.Timestamp("2026-01-05 14:30", tz="UTC")
        self._series: dict[str, pd.DataFrame] = {}
        self._offset = 0  # für Tests/Demos: manuell vorspulen

    def advance(self, minutes: int) -> None:
        self._offset += minutes

    def _sym_seed(self, symbol: str) -> int:
        h = hashlib.sha256(f"{self.seed}:{symbol}".encode()).hexdigest()
        return int(h[:8], 16)

    def _generate(self, symbol: str, n: int) -> pd.DataFrame:
        rng = np.random.default_rng(self._sym_seed(symbol))
        p0 = BASE_PRICES.get(symbol, 50 + (self._sym_seed(symbol) % 400))
        # Regime: Drift und Volatilität wechseln in Blöcken
        regime_len = rng.integers(180, 900, size=n // 180 + 2)
        drift = np.empty(n)
        vol = np.empty(n)
        i = 0
        for L in regime_len:
            if i >= n:
                break
            j = min(n, i + int(L))
            drift[i:j] = rng.normal(0, 0.00012)
            vol[i:j] = rng.uniform(0.0006, 0.0022)
            i = j
        shocks = rng.standard_t(df=4, size=n) / np.sqrt(2)
        jumps = (rng.random(n) < 0.0015) * rng.normal(0, 0.02, n)
        rets = drift + vol * shocks + jumps
        close = p0 * np.exp(np.cumsum(rets))
        open_ = np.concatenate([[p0], close[:-1]]) * (1 + rng.normal(0, 0.0002, n))
        spread = np.abs(rng.normal(0, 1, n)) * vol * close
        high = np.maximum(open_, close) + spread
        low = np.minimum(open_, close) - spread
        minute_of_day = np.arange(n) % 390
        u_shape = 1.6 - np.sin(np.pi * minute_of_day / 390)  # mehr Volumen zu Beginn/Ende
        volume = (rng.lognormal(10, 0.5, n) * u_shape * (1 + 30 * np.abs(jumps))).astype(int)
        idx = self._trading_index(n)
        return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close, "volume": volume}, index=idx)

    def _trading_index(self, n: int) -> pd.DatetimeIndex:
        """Minutenindex nur zu US-Handelszeiten (14:30–21:00 UTC, Mo–Fr)."""
        days = pd.bdate_range(self._anchor.normalize(), periods=n // 390 + 2, tz="UTC")
        stamps = [d + pd.Timedelta(hours=14, minutes=30) + pd.Timedelta(minutes=m) for d in days for m in range(390)]
        return pd.DatetimeIndex(stamps[:n])

    def _visible_len(self) -> int:
        base = self.history_minutes
        if self.live:
            base += int((time.time() - 1_767_225_600) // 60) % (390 * 5)  # wächst mit der Zeit
        return base + self._offset

    def _full(self, symbol: str) -> pd.DataFrame:
        n = self._visible_len()
        cached = self._series.get(symbol)
        if cached is None or len(cached) < n:
            cached = self._generate(symbol, n + 390 * 5)
            self._series[symbol] = cached
        return cached.iloc[:n]

    def get_bars(self, symbol: str, timeframe: str, limit: int) -> pd.DataFrame:
        minutes = tf_minutes(timeframe)
        df = self._full(symbol.upper())
        need = limit * minutes + minutes
        df = df.iloc[-need * 2:] if minutes < 1440 else df
        if minutes > 1:
            rule = f"{minutes}min" if minutes < 1440 else "1D"
            df = df.resample(rule, label="right", closed="right").agg(
                {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
            ).dropna()
        return df.iloc[-limit:].copy()
