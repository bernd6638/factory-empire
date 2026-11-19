from .base import Signal, Strategy, action_from_score
from .ml import MLStrategy
from .rules import Breakout, MeanReversion, TrendFollowing


def default_strategies() -> list[Strategy]:
    return [TrendFollowing(), MeanReversion(), Breakout(), MLStrategy()]


__all__ = ["Signal", "Strategy", "action_from_score", "TrendFollowing", "MeanReversion", "Breakout",
           "MLStrategy", "default_strategies"]
