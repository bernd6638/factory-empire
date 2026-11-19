"""Gebühren- und Slippage-Modell."""

from __future__ import annotations

from ..config import CostConfig


class CostModel:
    def __init__(self, cfg: CostConfig):
        self.cfg = cfg

    def commission(self, qty: float, price: float) -> float:
        if qty <= 0:
            return 0.0
        fee = qty * self.cfg.commission_per_share + qty * price * self.cfg.commission_pct
        return round(max(fee, self.cfg.commission_min), 4)

    def fill_price(self, side: str, ref_price: float) -> float:
        """Kauf wird teurer, Verkauf billiger ausgeführt (adverse Slippage)."""
        slip = ref_price * self.cfg.slippage_bps / 10_000
        return round(ref_price + slip if side == "BUY" else ref_price - slip, 6)
