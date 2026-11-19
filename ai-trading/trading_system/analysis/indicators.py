"""Technische Indikatoren (vektorisiert, ohne Look-Ahead).

Alle Funktionen nehmen ``pd.Series`` und geben Serien gleicher Länge zurück;
die Anlaufphase ist ``NaN``.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def sma(s: pd.Series, period: int) -> pd.Series:
    return s.rolling(period, min_periods=period).mean()


def ema(s: pd.Series, period: int) -> pd.Series:
    out = s.ewm(span=period, adjust=False, min_periods=period).mean()
    return out


def wilder_smooth(s: pd.Series, period: int) -> pd.Series:
    """Wilder-Glättung: Startwert = SMA der ersten ``period`` Werte, danach rekursiv (alpha = 1/period)."""
    x = s.to_numpy(dtype=float)
    out = np.full(len(x), np.nan)
    valid = np.flatnonzero(~np.isnan(x))
    if len(valid) < period:
        return pd.Series(out, index=s.index)
    start = valid[0]
    seed = start + period - 1
    out[seed] = np.nanmean(x[start:seed + 1])
    for t in range(seed + 1, len(x)):
        v = x[t] if not np.isnan(x[t]) else out[t - 1]
        out[t] = (out[t - 1] * (period - 1) + v) / period
    return pd.Series(out, index=s.index)


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    """RSI nach Wilder (SMA-Seed, danach Glättung alpha = 1/period)."""
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = wilder_smooth(gain, period)
    avg_loss = wilder_smooth(loss, period)
    rs = avg_gain / avg_loss.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    out = out.where(avg_loss != 0, 100.0)            # nur Gewinne -> 100
    out = out.where(~((avg_gain == 0) & (avg_loss == 0)), 50.0)
    return out.where(avg_gain.notna())


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.DataFrame:
    line = close.ewm(span=fast, adjust=False).mean() - close.ewm(span=slow, adjust=False).mean()
    sig = line.ewm(span=signal, adjust=False).mean()
    df = pd.DataFrame({"macd": line, "signal": sig, "hist": line - sig})
    df.iloc[: slow - 1] = np.nan
    return df


def bollinger(close: pd.Series, period: int = 20, num_std: float = 2.0) -> pd.DataFrame:
    mid = sma(close, period)
    std = close.rolling(period, min_periods=period).std(ddof=0)
    upper, lower = mid + num_std * std, mid - num_std * std
    width = (upper - lower) / mid
    pct_b = (close - lower) / (upper - lower).replace(0, np.nan)
    return pd.DataFrame({"mid": mid, "upper": upper, "lower": lower, "width": width, "pct_b": pct_b})


def true_range(df: pd.DataFrame) -> pd.Series:
    prev = df["close"].shift(1)
    return pd.concat([df["high"] - df["low"], (df["high"] - prev).abs(), (df["low"] - prev).abs()], axis=1).max(axis=1)


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Average True Range nach Wilder."""
    return wilder_smooth(true_range(df), period)


def adx(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Average Directional Index – Trendstärke (0–100)."""
    up = df["high"].diff()
    down = -df["low"].diff()
    plus_dm = np.where((up > down) & (up > 0), up, 0.0)
    minus_dm = np.where((down > up) & (down > 0), down, 0.0)
    tr = true_range(df).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    plus_di = 100 * pd.Series(plus_dm, index=df.index).ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / tr
    minus_di = 100 * pd.Series(minus_dm, index=df.index).ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / tr
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return dx.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def realized_volatility(close: pd.Series, window: int = 30, periods_per_year: float = 252 * 78) -> pd.Series:
    """Annualisierte Volatilität aus Log-Renditen (Default: 5-Minuten-Kerzen)."""
    lr = np.log(close).diff()
    return lr.rolling(window, min_periods=window).std() * np.sqrt(periods_per_year)


def vwap(df: pd.DataFrame) -> pd.Series:
    """Volumengewichteter Durchschnittspreis, täglich zurückgesetzt."""
    tp = (df["high"] + df["low"] + df["close"]) / 3
    day = df.index.normalize()
    pv = (tp * df["volume"]).groupby(day).cumsum()
    vol = df["volume"].groupby(day).cumsum().replace(0, np.nan)
    return pv / vol


def zscore(s: pd.Series, window: int = 50) -> pd.Series:
    m = s.rolling(window, min_periods=window).mean()
    sd = s.rolling(window, min_periods=window).std().replace(0, np.nan)
    return (s - m) / sd


def add_all(df: pd.DataFrame) -> pd.DataFrame:
    """Hängt alle Standardindikatoren an eine Kopie der Kerzen an."""
    out = df.copy()
    c = out["close"]
    out["sma_20"], out["sma_50"], out["sma_200"] = sma(c, 20), sma(c, 50), sma(c, 200)
    out["ema_9"], out["ema_21"], out["ema_50"] = ema(c, 9), ema(c, 21), ema(c, 50)
    out["rsi_14"] = rsi(c, 14)
    m = macd(c)
    out["macd"], out["macd_signal"], out["macd_hist"] = m["macd"], m["signal"], m["hist"]
    bb = bollinger(c)
    out["bb_mid"], out["bb_upper"], out["bb_lower"], out["bb_width"], out["bb_pct_b"] = (
        bb["mid"], bb["upper"], bb["lower"], bb["width"], bb["pct_b"])
    out["atr_14"] = atr(out)
    out["adx_14"] = adx(out)
    out["vol_rv"] = realized_volatility(c)
    out["ret_z"] = zscore(np.log(c).diff(), 50)
    out["volume_z"] = zscore(out["volume"].astype(float), 50)
    out["vwap"] = vwap(out)
    return out
