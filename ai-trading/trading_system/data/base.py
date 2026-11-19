"""Gemeinsame Schnittstelle für Marktdatenanbieter.

Alle Anbieter liefern ein ``pandas.DataFrame`` mit UTC-``DatetimeIndex`` und den
Spalten ``open, high, low, close, volume`` (aufsteigend sortiert).
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod

import pandas as pd

from ..errors import DataProviderError

COLUMNS = ["open", "high", "low", "close", "volume"]

TIMEFRAME_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440}
PANDAS_RULE = {"1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "4h": "4h", "1d": "1D"}


def tf_minutes(timeframe: str) -> int:
    try:
        return TIMEFRAME_MINUTES[timeframe]
    except KeyError as exc:
        raise DataProviderError(f"Unbekanntes Zeitintervall '{timeframe}'. Erlaubt: {list(TIMEFRAME_MINUTES)}") from exc


def validate_bars(df: pd.DataFrame, symbol: str) -> pd.DataFrame:
    """Normalisiert und prüft Kerzendaten. Entfernt kaputte Zeilen."""
    if df is None or df.empty:
        raise DataProviderError(f"Keine Daten für {symbol}")
    missing = [c for c in COLUMNS if c not in df.columns]
    if missing:
        raise DataProviderError(f"{symbol}: fehlende Spalten {missing}")
    out = df[COLUMNS].apply(pd.to_numeric, errors="coerce").dropna()
    out = out[(out["high"] >= out["low"]) & (out["close"] > 0)]
    if not isinstance(out.index, pd.DatetimeIndex):
        out.index = pd.to_datetime(out.index, utc=True)
    elif out.index.tz is None:
        out.index = out.index.tz_localize("UTC")
    out = out[~out.index.duplicated(keep="last")].sort_index()
    if out.empty:
        raise DataProviderError(f"{symbol}: nach Bereinigung keine gültigen Kerzen")
    return out


def resample(df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    """Aggregiert Kerzen auf ein höheres Zeitintervall (Multi-Timeframe-Analyse)."""
    rule = PANDAS_RULE[timeframe]
    agg = df.resample(rule, label="right", closed="right").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    )
    return agg.dropna()


class MarketDataProvider(ABC):
    name: str = "base"
    is_realtime: bool = False

    @abstractmethod
    def get_bars(self, symbol: str, timeframe: str, limit: int) -> pd.DataFrame:
        """Liefert die letzten ``limit`` Kerzen."""

    def get_latest_price(self, symbol: str) -> float:
        return float(self.get_bars(symbol, "1m", 2)["close"].iloc[-1])

    def healthcheck(self) -> tuple[bool, str]:
        return True, "ok"


class CachedProvider(MarketDataProvider):
    """TTL-Cache vor einem Anbieter, um Rate-Limits zu schonen."""

    def __init__(self, inner: MarketDataProvider, ttl_sec: float = 20.0):
        self.inner = inner
        self.ttl = ttl_sec
        self.name = inner.name
        self.is_realtime = inner.is_realtime
        self._cache: dict[tuple, tuple[float, pd.DataFrame]] = {}

    def get_bars(self, symbol: str, timeframe: str, limit: int) -> pd.DataFrame:
        key = (symbol, timeframe, limit)
        hit = self._cache.get(key)
        now = time.monotonic()
        if hit and now - hit[0] < self.ttl:
            return hit[1]
        df = self.inner.get_bars(symbol, timeframe, limit)
        self._cache[key] = (now, df)
        return df

    def healthcheck(self):
        return self.inner.healthcheck()


class FallbackProvider(MarketDataProvider):
    """Probiert mehrere Anbieter nacheinander (z. B. Alpaca -> Yahoo -> Simulation)."""

    def __init__(self, providers: list[MarketDataProvider], cooldown_sec: float = 300.0):
        if not providers:
            raise DataProviderError("FallbackProvider benötigt mindestens einen Anbieter")
        self.providers = providers
        self.name = "+".join(p.name for p in providers)
        self.last_used: str | None = None
        self.errors: dict[str, str] = {}
        self.cooldown = cooldown_sec
        self._down_until: dict[str, float] = {}  # Circuit-Breaker je Anbieter

    @property
    def is_realtime(self) -> bool:  # type: ignore[override]
        return any(p.is_realtime and p.name == self.last_used for p in self.providers)

    def get_bars(self, symbol: str, timeframe: str, limit: int) -> pd.DataFrame:
        last_exc: Exception | None = None
        now = time.monotonic()
        for i, p in enumerate(self.providers):
            is_last = i == len(self.providers) - 1
            if not is_last and self._down_until.get(p.name, 0) > now:
                continue  # Anbieter pausiert nach Fehler
            try:
                df = p.get_bars(symbol, timeframe, limit)
                self.last_used = p.name
                self._down_until.pop(p.name, None)
                return df
            except Exception as exc:  # noqa: BLE001 - jeder Fehler -> nächster Anbieter
                self.errors[p.name] = str(exc)[:300]
                self._down_until[p.name] = now + self.cooldown
                last_exc = exc
        raise DataProviderError(f"Alle Anbieter fehlgeschlagen für {symbol}: {last_exc}")

    def healthcheck(self):
        results = [f"{p.name}: {'ok' if p.healthcheck()[0] else 'fehler'}" for p in self.providers]
        return True, "; ".join(results)
