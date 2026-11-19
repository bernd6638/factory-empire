"""Strategie-Schnittstelle.

Jede Strategie liefert eine vektorisierte Score-Serie in [-1, +1]
(+1 = starkes Kaufsignal, -1 = starkes Verkaufssignal) und für die
aktuelle Kerze ein ``Signal`` mit Begründungen. Scores dürfen nur
Informationen bis einschließlich der jeweiligen Kerze nutzen.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd


@dataclass
class Signal:
    strategy: str
    score: float                 # -1..+1
    action: str                  # BUY | SELL | HOLD
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def action_from_score(score: float, threshold: float = 0.2) -> str:
    return "BUY" if score >= threshold else "SELL" if score <= -threshold else "HOLD"


class Strategy(ABC):
    name: str = "base"
    description: str = ""

    @abstractmethod
    def score_series(self, ind: pd.DataFrame) -> pd.Series:
        """Score je Kerze (NaN während der Anlaufphase)."""

    @abstractmethod
    def explain(self, row: pd.Series, score: float) -> list[str]:
        """Menschlich lesbare Begründung für die letzte Kerze."""

    def generate(self, ind: pd.DataFrame) -> Signal:
        s = self.score_series(ind)
        score = float(s.iloc[-1]) if len(s) and not np.isnan(s.iloc[-1]) else 0.0
        score = float(np.clip(score, -1, 1))
        return Signal(self.name, round(score, 4), action_from_score(score), self.explain(ind.iloc[-1], score))
