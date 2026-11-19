"""Lernende Strategie: logistische Regression (numpy, L2) auf technischen Merkmalen.

Das Modell wird walk-forward trainiert: Für die Vorhersage an Kerze t werden
nur Beispiele verwendet, deren Zielwert (Rendite der nächsten ``horizon``
Kerzen) zum Zeitpunkt t bereits bekannt war. Es gibt keine Gewinngarantie –
das Modell schätzt lediglich eine Wahrscheinlichkeit für steigende Kurse.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .base import Strategy

FEATURES = ["rsi_n", "macd_n", "bb", "ema_gap", "ret_5", "ret_20", "vol_z", "adx_n", "vwap_dev"]


def build_features(ind: pd.DataFrame) -> pd.DataFrame:
    c = ind["close"]
    atr = ind["atr_14"].replace(0, np.nan)
    f = pd.DataFrame(index=ind.index)
    f["rsi_n"] = (ind["rsi_14"] - 50) / 25
    f["macd_n"] = np.tanh(ind["macd_hist"] / (0.1 * atr))
    f["bb"] = (ind["bb_pct_b"] - 0.5) * 2
    f["ema_gap"] = np.tanh((ind["ema_9"] - ind["ema_50"]) / atr)
    f["ret_5"] = np.tanh(c.pct_change(5) / (atr / c) / 3)
    f["ret_20"] = np.tanh(c.pct_change(20) / (atr / c) / 6)
    f["vol_z"] = np.tanh(ind["volume_z"].fillna(0) / 3)  # konstantes Volumen -> neutral
    f["adx_n"] = (ind["adx_14"] - 25) / 25
    f["vwap_dev"] = np.tanh((c - ind["vwap"]) / atr)
    return f


class LogisticModel:
    def __init__(self, l2: float = 1.0, lr: float = 0.5, epochs: int = 200):
        self.l2, self.lr, self.epochs = l2, lr, epochs
        self.w: np.ndarray | None = None
        self.b = 0.0

    def fit(self, X: np.ndarray, y: np.ndarray) -> "LogisticModel":
        n, d = X.shape
        w = np.zeros(d) if self.w is None or len(self.w) != d else self.w.copy()
        b = self.b
        for _ in range(self.epochs):
            p = 1 / (1 + np.exp(-(X @ w + b)))
            g = p - y
            w -= self.lr * (X.T @ g / n + self.l2 * w / n)
            b -= self.lr * g.mean()
        self.w, self.b = w, b
        return self

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        if self.w is None:
            return np.full(len(X), 0.5)
        return 1 / (1 + np.exp(-np.clip(X @ self.w + self.b, -30, 30)))


class MLStrategy(Strategy):
    name = "ml_logistic"
    description = "Walk-forward logistische Regression auf 9 technischen Merkmalen"

    def __init__(self, horizon: int = 6, min_train: int = 120, retrain_every: int = 25, train_window: int = 1500):
        self.horizon = horizon
        self.min_train = min_train
        self.retrain_every = retrain_every
        self.train_window = train_window
        self.last_model: LogisticModel | None = None

    def score_series(self, ind: pd.DataFrame) -> pd.Series:
        feats = build_features(ind)
        fwd = ind["close"].shift(-self.horizon) / ind["close"] - 1
        X_all = feats.to_numpy(dtype=float)
        valid = ~np.isnan(X_all).any(axis=1)
        y_all = (fwd > 0).astype(float).to_numpy()
        known = ~np.isnan(fwd.to_numpy())
        out = np.full(len(ind), np.nan)
        model = LogisticModel()
        first = None
        n = len(ind)
        for t in range(n):
            if not valid[t]:
                continue
            end = t - self.horizon  # letzte Zeile, deren Ziel bei t bekannt ist (inklusive)
            if end < 0:
                continue
            if first is None or (t - first) % self.retrain_every == 0:
                lo = max(0, end + 1 - self.train_window)
                mask = valid[lo:end + 1] & known[lo:end + 1]
                if mask.sum() < self.min_train:
                    continue
                X = X_all[lo:end + 1][mask]
                y = y_all[lo:end + 1][mask]
                model.fit(X, y)
                if first is None:
                    first = t
            p = model.predict_proba(X_all[t:t + 1])[0]
            out[t] = 2 * p - 1
        self.last_model = model if model.w is not None else None
        return pd.Series(np.clip(out * 1.5, -1, 1), index=ind.index)

    def explain(self, row, score):
        if self.last_model is None:
            return ["Zu wenig Historie zum Trainieren – neutral"]
        p = (score / 1.5 + 1) / 2
        w = dict(zip(FEATURES, self.last_model.w))
        top = sorted(w.items(), key=lambda kv: abs(kv[1]), reverse=True)[:3]
        return [f"Geschätzte Aufwärtswahrscheinlichkeit (nächste {self.horizon} Kerzen): {p:.0%}",
                "Wichtigste Merkmale: " + ", ".join(f"{k} ({v:+.2f})" for k, v in top)]
