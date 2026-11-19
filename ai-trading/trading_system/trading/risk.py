"""Risikomanagement: Positionsgröße, Limits, Kill-Switch."""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..config import RiskConfig


@dataclass
class SizingResult:
    qty: int
    risk_amount: float
    position_value: float
    reason: str


class RiskManager:
    def __init__(self, cfg: RiskConfig):
        self.cfg = cfg

    def position_size(self, equity: float, cash: float, entry: float, stop: float,
                      current_exposure: float = 0.0, confidence: float = 1.0) -> SizingResult:
        """Fixed-Fractional-Sizing: Risiko = equity * risk_per_trade * Konfidenzfaktor.

        Stückzahl = Risiko / |Entry - Stop|, begrenzt durch max. Positionsgröße,
        verbleibendes Exposure-Budget und verfügbares Bargeld.
        """
        per_share = abs(entry - stop)
        if entry <= 0 or per_share <= 0 or equity <= 0:
            return SizingResult(0, 0.0, 0.0, "Ungültige Preise oder kein Eigenkapital")
        conf_factor = 0.5 + 0.5 * max(0.0, min(1.0, confidence))  # 50–100 % des Basisrisikos
        risk_amount = equity * self.cfg.risk_per_trade * conf_factor
        qty = math.floor(risk_amount / per_share)
        limits = {
            "Risiko pro Trade": qty,
            "max. Positionsgröße": math.floor(equity * self.cfg.max_position_pct / entry),
            "Exposure-Limit": math.floor(max(0.0, equity * self.cfg.max_gross_exposure - current_exposure) / entry),
            "verfügbares Bargeld": math.floor(cash * 0.995 / entry),
        }
        binding = min(limits, key=limits.get)
        qty = max(0, limits[binding])
        return SizingResult(qty, round(qty * per_share, 2), round(qty * entry, 2), f"begrenzt durch {binding}")

    def can_open(self, open_positions: int, day_pnl_pct: float, drawdown_pct: float) -> tuple[bool, str]:
        if day_pnl_pct <= -self.cfg.daily_loss_limit:
            return False, f"Tagesverlustlimit erreicht ({day_pnl_pct:.2%})"
        if drawdown_pct >= self.cfg.max_drawdown_limit:
            return False, f"Max. Drawdown erreicht ({drawdown_pct:.2%})"
        if open_positions >= self.cfg.max_open_positions:
            return False, f"Max. Anzahl offener Positionen ({self.cfg.max_open_positions}) erreicht"
        return True, "ok"
