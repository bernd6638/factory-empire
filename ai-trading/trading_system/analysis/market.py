"""Marktanalyse: Trend, Volatilitätsregime, Anomalien, Multi-Timeframe."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from ..errors import InsufficientDataError
from .indicators import add_all

MIN_BARS = 60


@dataclass
class Anomaly:
    kind: str           # price_shock | volume_spike | gap | volatility_expansion
    severity: float     # z-Score bzw. Faktor
    message: str


@dataclass
class TimeframeView:
    timeframe: str
    trend: str          # up | down | sideways
    trend_strength: float
    rsi: float
    macd_hist: float
    above_sma50: bool


@dataclass
class MarketAnalysis:
    symbol: str
    timeframe: str
    timestamp: str
    price: float
    trend: str
    trend_strength: float        # 0..1
    adx: float
    volatility_regime: str       # low | normal | high
    realized_vol: float
    atr: float
    atr_pct: float
    rsi: float
    macd_hist: float
    bb_pct_b: float
    bb_width: float
    vwap_dev: float
    anomalies: list[Anomaly] = field(default_factory=list)
    timeframes: list[TimeframeView] = field(default_factory=list)
    mtf_alignment: float = 0.0   # -1 (alle abwärts) .. +1 (alle aufwärts)
    summary: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _f(x, default: float = 0.0) -> float:
    try:
        v = float(x)
        return default if np.isnan(v) or np.isinf(v) else v
    except (TypeError, ValueError):
        return default


def classify_trend(row: pd.Series) -> tuple[str, float]:
    """Trend aus EMA-Ordnung, SMA50-Lage, MACD und ADX; Stärke 0..1."""
    score = 0.0
    score += 1 if row["ema_9"] > row["ema_21"] else -1
    score += 1 if row["ema_21"] > row["ema_50"] else -1
    score += 1 if row["close"] > row["sma_50"] else -1
    score += 0.5 if row["macd_hist"] > 0 else -0.5
    adx_v = _f(row.get("adx_14"), 15)
    strength = min(1.0, abs(score) / 3.5 * min(1.0, adx_v / 25))
    if adx_v < 18 or abs(score) < 2:
        return "sideways", round(strength, 3)
    return ("up" if score > 0 else "down"), round(strength, 3)


def detect_anomalies(ind: pd.DataFrame, price_z: float = 3.5, volume_z: float = 3.5) -> list[Anomaly]:
    last = ind.iloc[-1]
    out: list[Anomaly] = []
    rz = _f(last.get("ret_z"))
    if abs(rz) >= price_z:
        out.append(Anomaly("price_shock", round(rz, 2),
                           f"Ungewöhnliche Kursbewegung ({'+' if rz > 0 else ''}{rz:.1f}σ)"))
    vz = _f(last.get("volume_z"))
    if vz >= volume_z:
        out.append(Anomaly("volume_spike", round(vz, 2), f"Volumenspitze ({vz:.1f}σ über Durchschnitt)"))
    if len(ind) > 1:
        prev = ind.iloc[-2]
        gap = (last["open"] - prev["close"]) / prev["close"]
        atr_pct = _f(prev.get("atr_14")) / prev["close"] if prev["close"] else 0
        if atr_pct and abs(gap) > 3 * atr_pct:
            out.append(Anomaly("gap", round(gap * 100, 2), f"Kurslücke von {gap * 100:+.2f} %"))
    widths = ind["bb_width"].dropna()
    if len(widths) > 50:
        ratio = widths.iloc[-1] / widths.iloc[-50:].median()
        if ratio > 2.0:
            out.append(Anomaly("volatility_expansion", round(ratio, 2), f"Volatilitätsausbruch (Bandbreite ×{ratio:.1f})"))
    return out


def volatility_regime(ind: pd.DataFrame) -> str:
    rv = ind["vol_rv"].dropna()
    if len(rv) < 50:
        return "normal"
    cur, lo, hi = rv.iloc[-1], rv.quantile(0.25), rv.quantile(0.80)
    return "high" if cur > hi else "low" if cur < lo else "normal"


def timeframe_view(df: pd.DataFrame, timeframe: str) -> TimeframeView | None:
    if len(df) < MIN_BARS:
        return None
    ind = add_all(df)
    last = ind.iloc[-1]
    if pd.isna(last["sma_50"]):
        return None
    trend, strength = classify_trend(last)
    return TimeframeView(timeframe, trend, strength, round(_f(last["rsi_14"], 50), 2),
                         round(_f(last["macd_hist"]), 4), bool(last["close"] > last["sma_50"]))


def analyze(symbol: str, df: pd.DataFrame, timeframe: str,
            higher: dict[str, pd.DataFrame] | None = None) -> tuple[MarketAnalysis, pd.DataFrame]:
    """Vollständige Analyse eines Symbols. Gibt Analyse + Indikator-Frame zurück."""
    if df is None or len(df) < MIN_BARS:
        raise InsufficientDataError(f"{symbol}: mindestens {MIN_BARS} Kerzen benötigt, erhalten {0 if df is None else len(df)}")
    ind = add_all(df)
    last = ind.iloc[-1]
    trend, strength = classify_trend(last.fillna(0))
    price = float(last["close"])
    atr_v = _f(last["atr_14"])
    views = [v for v in [timeframe_view(df, timeframe)] if v]
    for tf, hdf in (higher or {}).items():
        v = timeframe_view(hdf, tf)
        if v:
            views.append(v)
    align = float(np.mean([{"up": 1, "down": -1}.get(v.trend, 0) for v in views])) if views else 0.0
    anomalies = detect_anomalies(ind)
    regime = volatility_regime(ind)
    vw = _f(last.get("vwap"), price)
    a = MarketAnalysis(
        symbol=symbol, timeframe=timeframe, timestamp=str(ind.index[-1]), price=round(price, 4),
        trend=trend, trend_strength=strength, adx=round(_f(last["adx_14"]), 2),
        volatility_regime=regime, realized_vol=round(_f(last["vol_rv"]), 4), atr=round(atr_v, 4),
        atr_pct=round(atr_v / price * 100, 3) if price else 0.0, rsi=round(_f(last["rsi_14"], 50), 2),
        macd_hist=round(_f(last["macd_hist"]), 4), bb_pct_b=round(_f(last["bb_pct_b"], 0.5), 3),
        bb_width=round(_f(last["bb_width"]), 4), vwap_dev=round((price - vw) / vw * 100, 3) if vw else 0.0,
        anomalies=anomalies, timeframes=views, mtf_alignment=round(align, 3),
    )
    a.summary = summarize(a)
    return a, ind


def summarize(a: MarketAnalysis) -> str:
    trend_de = {"up": "Aufwärtstrend", "down": "Abwärtstrend", "sideways": "Seitwärtsphase"}[a.trend]
    vol_de = {"low": "niedrige", "normal": "normale", "high": "erhöhte"}[a.volatility_regime]
    rsi_txt = "überkauft" if a.rsi > 70 else "überverkauft" if a.rsi < 30 else "neutral"
    parts = [f"{a.symbol}: {trend_de} (Stärke {a.trend_strength:.0%}, ADX {a.adx:.0f}), {vol_de} Volatilität "
             f"(ATR {a.atr_pct:.2f} %). RSI {a.rsi:.0f} ({rsi_txt}), MACD-Histogramm {'positiv' if a.macd_hist > 0 else 'negativ'}."]
    if a.timeframes:
        parts.append("Zeitebenen: " + ", ".join(f"{v.timeframe}={v.trend}" for v in a.timeframes) +
                     f" (Übereinstimmung {a.mtf_alignment:+.2f}).")
    if a.anomalies:
        parts.append("Auffälligkeiten: " + "; ".join(x.message for x in a.anomalies) + ".")
    return " ".join(parts)


def analysis_from_indicators(symbol: str, ind: pd.DataFrame, timeframe: str, mtf_alignment: float = 0.0,
                             regime_window: int = 500) -> MarketAnalysis:
    """Schnelle Analyse aus bereits berechneten Indikatoren (für Backtests, ohne Neuberechnung).

    ``ind`` darf nur Daten bis zum Entscheidungszeitpunkt enthalten.
    """
    if len(ind) < MIN_BARS:
        raise InsufficientDataError(f"{symbol}: zu wenige Kerzen")
    tail = ind.iloc[-regime_window:]
    last = tail.iloc[-1]
    trend, strength = classify_trend(last.fillna(0))
    price = float(last["close"])
    atr_v = _f(last["atr_14"])
    a = MarketAnalysis(
        symbol=symbol, timeframe=timeframe, timestamp=str(tail.index[-1]), price=round(price, 4),
        trend=trend, trend_strength=strength, adx=round(_f(last["adx_14"]), 2),
        volatility_regime=volatility_regime(tail), realized_vol=round(_f(last["vol_rv"]), 4), atr=round(atr_v, 4),
        atr_pct=round(atr_v / price * 100, 3) if price else 0.0, rsi=round(_f(last["rsi_14"], 50), 2),
        macd_hist=round(_f(last["macd_hist"]), 4), bb_pct_b=round(_f(last["bb_pct_b"], 0.5), 3),
        bb_width=round(_f(last["bb_width"]), 4), vwap_dev=0.0, anomalies=detect_anomalies(tail.iloc[-60:]),
        mtf_alignment=round(mtf_alignment, 3),
    )
    a.summary = summarize(a)
    return a


def higher_tf_trend_series(df: pd.DataFrame, timeframe: str) -> pd.Series:
    """Trendrichtung (+1/0/-1) der höheren Zeitebene, kausal auf die Basis-Kerzen gemappt.

    Höhere Kerzen sind mit ihrem Endzeitpunkt beschriftet und werden erst ab dann
    (forward-fill) verwendet – kein Look-Ahead.
    """
    from ..data.base import resample
    h = resample(df, timeframe)
    if len(h) < MIN_BARS:
        return pd.Series(0.0, index=df.index)
    hi = add_all(h)
    tr = hi.apply(lambda r: {"up": 1.0, "down": -1.0}.get(classify_trend(r.fillna(0))[0], 0.0)
                  if not pd.isna(r["sma_50"]) else 0.0, axis=1)
    return tr.reindex(df.index, method="ffill").fillna(0.0)
