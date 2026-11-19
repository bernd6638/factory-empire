"""Regelbasierte Strategien: Trendfolge, Mean-Reversion, Breakout."""

from __future__ import annotations

import numpy as np
import pandas as pd

from .base import Strategy


class TrendFollowing(Strategy):
    name = "trend_following"
    description = "EMA-9/21/50-Ordnung + MACD-Histogramm, gefiltert mit ADX"

    def score_series(self, ind: pd.DataFrame) -> pd.Series:
        ema_fast = np.sign(ind["ema_9"] - ind["ema_21"])
        ema_slow = np.sign(ind["ema_21"] - ind["ema_50"])
        macd_n = np.tanh(ind["macd_hist"] / (ind["atr_14"] * 0.1).replace(0, np.nan))
        raw = 0.35 * ema_fast + 0.35 * ema_slow + 0.30 * macd_n
        adx_gate = ((ind["adx_14"] - 15) / 15).clip(0, 1)  # unter ADX 15 kein Trendsignal
        return (raw * adx_gate).clip(-1, 1)

    def explain(self, row, score):
        r = []
        r.append(f"EMA9 {'über' if row['ema_9'] > row['ema_21'] else 'unter'} EMA21, "
                 f"EMA21 {'über' if row['ema_21'] > row['ema_50'] else 'unter'} EMA50")
        r.append(f"MACD-Histogramm {row['macd_hist']:+.4f}")
        r.append(f"ADX {row['adx_14']:.1f} ({'Trend vorhanden' if row['adx_14'] > 20 else 'schwacher Trend'})")
        return r


class MeanReversion(Strategy):
    name = "mean_reversion"
    description = "RSI-Extreme + Bollinger-%B, nur in trendarmen Phasen"

    def score_series(self, ind: pd.DataFrame) -> pd.Series:
        rsi_part = ((50 - ind["rsi_14"]) / 20).clip(-1, 1)           # RSI 30 -> +1, RSI 70 -> -1
        bb_part = ((0.5 - ind["bb_pct_b"]) * 1.6).clip(-1, 1)        # unteres Band -> +
        raw = 0.5 * rsi_part + 0.5 * bb_part
        # nur extreme Lagen handeln, Rest dämpfen
        raw = raw.where(raw.abs() > 0.5, raw * 0.3)
        range_gate = ((40 - ind["adx_14"]) / 15).clip(0, 1)          # starker Trend (ADX>40) -> aus
        return (raw * range_gate).clip(-1, 1)

    def explain(self, row, score):
        return [f"RSI {row['rsi_14']:.1f}", f"Bollinger %B {row['bb_pct_b']:.2f}",
                f"ADX {row['adx_14']:.1f} ({'Seitwärtsmarkt – Strategie aktiv' if row['adx_14'] < 25 else 'Trendmarkt – gedämpft' if row['adx_14'] < 40 else 'starker Trend – inaktiv'})"]


class Breakout(Strategy):
    name = "breakout"
    description = "Donchian-20-Ausbruch mit Volumenbestätigung"

    def __init__(self, window: int = 20):
        self.window = window

    def score_series(self, ind: pd.DataFrame) -> pd.Series:
        hi = ind["high"].rolling(self.window).max().shift(1)
        lo = ind["low"].rolling(self.window).min().shift(1)
        atr = ind["atr_14"].replace(0, np.nan)
        up = ((ind["close"] - hi) / atr).clip(lower=0)
        dn = ((lo - ind["close"]) / atr).clip(lower=0)
        raw = np.tanh(2 * (up - dn))
        vol_conf = (0.5 + 0.25 * ind["volume_z"].fillna(0)).clip(0.3, 1.0)
        return (raw * vol_conf).clip(-1, 1)

    def explain(self, row, score):
        if score > 0.1:
            r = [f"Schlusskurs über {self.window}-Perioden-Hoch"]
        elif score < -0.1:
            r = [f"Schlusskurs unter {self.window}-Perioden-Tief"]
        else:
            r = ["Kein Ausbruch aus der Handelsspanne"]
        r.append(f"Volumen-z {row['volume_z']:+.1f}")
        return r
