"""Paper-Broker: simuliert Orders mit virtuellem Kapital.

Es gibt hier absichtlich keinerlei Verbindung zu einem echten Broker.
Ausführung: Marktorders zum Referenzpreis ± Slippage, plus Kommission.
Stop-Loss/Take-Profit werden bei jeder neuen Kerze gegen High/Low geprüft;
liegt die Eröffnung bereits jenseits des Levels (Gap), wird zum Eröffnungs-
kurs ausgeführt. Werden SL und TP in derselben Kerze berührt, wird
konservativ der Stop-Loss angenommen.
"""

from __future__ import annotations

import threading
from dataclasses import asdict, dataclass

from ..config import enforce_paper
from ..errors import OrderRejectedError
from .costs import CostModel
from .ledger import Ledger


@dataclass
class Position:
    symbol: str
    side: str            # LONG | SHORT
    qty: float
    entry_price: float   # inkl. Slippage
    entry_ts: str
    stop_loss: float
    take_profit: float
    entry_fees: float
    decision_id: str | None = None
    last_price: float = 0.0

    @property
    def direction(self) -> int:
        return 1 if self.side == "LONG" else -1

    @property
    def market_value(self) -> float:
        return self.direction * self.qty * self.last_price

    @property
    def unrealized_pnl(self) -> float:
        return self.direction * self.qty * (self.last_price - self.entry_price)

    def to_dict(self) -> dict:
        d = asdict(self)
        d.update(market_value=round(self.market_value, 2), unrealized_pnl=round(self.unrealized_pnl, 2),
                 unrealized_pct=round(self.direction * (self.last_price / self.entry_price - 1) * 100, 3)
                 if self.entry_price else 0.0)
        return d


class PaperBroker:
    mode = "paper"

    def __init__(self, initial_capital: float, costs: CostModel, ledger: Ledger | None = None,
                 allow_short: bool = False):
        enforce_paper(self.mode)
        self.initial_capital = float(initial_capital)
        self.costs = costs
        self.ledger = ledger or Ledger(":memory:")
        self.allow_short = allow_short
        self.cash = float(initial_capital)
        self.positions: dict[str, Position] = {}
        self.peak_equity = float(initial_capital)
        self.day_start: dict[str, float] = {}
        self.realized_pnl = 0.0
        self.total_fees = 0.0
        self._lock = threading.RLock()
        self._restore()

    # ---------- Persistenz ----------
    def _restore(self) -> None:
        st = self.ledger.load_state("broker")
        if not st:
            return
        self.cash = st["cash"]
        self.peak_equity = st.get("peak_equity", self.initial_capital)
        self.realized_pnl = st.get("realized_pnl", 0.0)
        self.total_fees = st.get("total_fees", 0.0)
        self.day_start = st.get("day_start", {})
        self.initial_capital = st.get("initial_capital", self.initial_capital)
        self.positions = {k: Position(**v) for k, v in st.get("positions", {}).items()}

    def _persist(self) -> None:
        self.ledger.save_state("broker", {
            "cash": self.cash, "peak_equity": self.peak_equity, "realized_pnl": self.realized_pnl,
            "total_fees": self.total_fees, "day_start": self.day_start, "initial_capital": self.initial_capital,
            "positions": {k: asdict(v) for k, v in self.positions.items()},
        })

    # ---------- Kennzahlen ----------
    @property
    def exposure(self) -> float:
        return sum(abs(p.market_value) for p in self.positions.values())

    @property
    def equity(self) -> float:
        return self.cash + sum(p.market_value for p in self.positions.values())

    def drawdown(self) -> float:
        eq = self.equity
        return max(0.0, (self.peak_equity - eq) / self.peak_equity) if self.peak_equity else 0.0

    def day_pnl_pct(self, day: str) -> float:
        start = self.day_start.get(day)
        return (self.equity / start - 1) if start else 0.0

    # ---------- Orders ----------
    def open_position(self, symbol: str, side: str, qty: int, ref_price: float, ts: str,
                      stop_loss: float, take_profit: float, decision_id: str | None = None,
                      reason: str = "signal") -> Position:
        with self._lock:
            if side not in ("LONG", "SHORT"):
                raise OrderRejectedError(f"Ungültige Seite {side}")
            if side == "SHORT" and not self.allow_short:
                raise OrderRejectedError("Leerverkäufe sind deaktiviert")
            if symbol in self.positions:
                raise OrderRejectedError(f"{symbol}: Position bereits offen")
            if qty <= 0 or ref_price <= 0:
                raise OrderRejectedError("Menge und Preis müssen > 0 sein")
            if side == "LONG" and not (stop_loss < ref_price < take_profit):
                raise OrderRejectedError("Long: Stop < Preis < Take-Profit erforderlich")
            if side == "SHORT" and not (take_profit < ref_price < stop_loss):
                raise OrderRejectedError("Short: Take-Profit < Preis < Stop erforderlich")
            order_side = "BUY" if side == "LONG" else "SELL"
            fill = self.costs.fill_price(order_side, ref_price)
            fee = self.costs.commission(qty, fill)
            cash_delta = -qty * fill - fee if side == "LONG" else qty * fill - fee
            if side == "LONG" and -cash_delta > self.cash:
                raise OrderRejectedError(f"Nicht genug Kapital: benötigt {-cash_delta:.2f}, verfügbar {self.cash:.2f}")
            self.cash += cash_delta
            self.total_fees += fee
            pos = Position(symbol, side, qty, fill, ts, stop_loss, take_profit, fee, decision_id, last_price=ref_price)
            self.positions[symbol] = pos
            self.ledger.add_transaction(ts=ts, symbol=symbol, side=order_side, qty=qty, ref_price=ref_price,
                                        fill_price=fill, commission=fee, slippage_cost=round(abs(fill - ref_price) * qty, 4),
                                        reason=f"Eröffnung ({reason})", decision_id=decision_id, cash_after=round(self.cash, 2))
            self._persist()
            return pos

    def close_position(self, symbol: str, ref_price: float, ts: str, reason: str = "signal") -> dict:
        with self._lock:
            pos = self.positions.get(symbol)
            if not pos:
                raise OrderRejectedError(f"{symbol}: keine offene Position")
            order_side = "SELL" if pos.side == "LONG" else "BUY"
            fill = self.costs.fill_price(order_side, ref_price)
            fee = self.costs.commission(pos.qty, fill)
            if pos.side == "LONG":
                self.cash += pos.qty * fill - fee
            else:
                self.cash -= pos.qty * fill + fee
            gross = pos.direction * pos.qty * (fill - pos.entry_price)
            fees = pos.entry_fees + fee
            pnl = gross - fees
            cost_basis = pos.qty * pos.entry_price
            self.realized_pnl += pnl
            self.total_fees += fee
            del self.positions[symbol]
            self.ledger.add_transaction(ts=ts, symbol=symbol, side=order_side, qty=pos.qty, ref_price=ref_price,
                                        fill_price=fill, commission=fee, slippage_cost=round(abs(fill - ref_price) * pos.qty, 4),
                                        reason=f"Schließung ({reason})", decision_id=pos.decision_id, cash_after=round(self.cash, 2))
            trade = dict(symbol=symbol, side=pos.side, qty=pos.qty, entry_ts=pos.entry_ts, entry_price=pos.entry_price,
                         exit_ts=ts, exit_price=fill, pnl=round(pnl, 2), pnl_pct=round(pnl / cost_basis * 100, 3),
                         fees=round(fees, 4), exit_reason=reason, decision_id=pos.decision_id)
            self.ledger.add_trade(**trade)
            self._persist()
            return trade

    def on_bar(self, symbol: str, ts: str, open_: float, high: float, low: float, close: float) -> dict | None:
        """Aktualisiert Kurs und prüft Stop-Loss/Take-Profit. Gibt ggf. den geschlossenen Trade zurück."""
        with self._lock:
            pos = self.positions.get(symbol)
            if not pos:
                return None
            if pos.side == "LONG":
                if open_ <= pos.stop_loss:
                    return self.close_position(symbol, open_, ts, "Stop-Loss (Gap)")
                if low <= pos.stop_loss:
                    return self.close_position(symbol, pos.stop_loss, ts, "Stop-Loss")
                if open_ >= pos.take_profit:
                    return self.close_position(symbol, open_, ts, "Take-Profit (Gap)")
                if high >= pos.take_profit:
                    return self.close_position(symbol, pos.take_profit, ts, "Take-Profit")
            else:
                if open_ >= pos.stop_loss:
                    return self.close_position(symbol, open_, ts, "Stop-Loss (Gap)")
                if high >= pos.stop_loss:
                    return self.close_position(symbol, pos.stop_loss, ts, "Stop-Loss")
                if open_ <= pos.take_profit:
                    return self.close_position(symbol, open_, ts, "Take-Profit (Gap)")
                if low <= pos.take_profit:
                    return self.close_position(symbol, pos.take_profit, ts, "Take-Profit")
            pos.last_price = close
            return None

    def mark(self, prices: dict[str, float], ts: str, record: bool = True) -> float:
        with self._lock:
            for sym, p in prices.items():
                if sym in self.positions and p > 0:
                    self.positions[sym].last_price = p
            eq = self.equity
            self.peak_equity = max(self.peak_equity, eq)
            day = ts[:10]
            self.day_start.setdefault(day, eq)
            if len(self.day_start) > 10:
                for k in sorted(self.day_start)[:-10]:
                    del self.day_start[k]
            if record:
                self.ledger.add_equity(ts, round(eq, 2), round(self.cash, 2), round(self.exposure, 2))
            self._persist()
            return eq

    def snapshot(self) -> dict:
        with self._lock:
            eq = self.equity
            return {
                "mode": self.mode, "initial_capital": self.initial_capital, "cash": round(self.cash, 2),
                "equity": round(eq, 2), "exposure": round(self.exposure, 2),
                "exposure_pct": round(self.exposure / eq * 100, 2) if eq else 0.0,
                "realized_pnl": round(self.realized_pnl, 2),
                "unrealized_pnl": round(sum(p.unrealized_pnl for p in self.positions.values()), 2),
                "total_return_pct": round((eq / self.initial_capital - 1) * 100, 3),
                "total_fees": round(self.total_fees, 2), "drawdown_pct": round(self.drawdown() * 100, 3),
                "peak_equity": round(self.peak_equity, 2),
                "positions": [p.to_dict() for p in self.positions.values()],
            }
