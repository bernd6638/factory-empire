import pandas as pd
import pytest

from trading_system.config import CostConfig, RiskConfig
from trading_system.errors import OrderRejectedError
from trading_system.trading.broker import PaperBroker
from trading_system.trading.costs import CostModel
from trading_system.trading.ledger import Ledger
from trading_system.trading.metrics import equity_metrics, trade_metrics
from trading_system.trading.risk import RiskManager

TS = "2026-03-02T15:00:00+00:00"


def broker(cap=10_000, slippage=10.0, per_share=0.01, minimum=1.0, short=False, ledger=None):
    return PaperBroker(cap, CostModel(CostConfig(commission_per_share=per_share, commission_min=minimum,
                                                 slippage_bps=slippage)), ledger or Ledger(), allow_short=short)


def test_costs_slippage_direction_and_min_fee():
    c = CostModel(CostConfig(commission_per_share=0.005, commission_min=1.0, slippage_bps=10))
    assert c.fill_price("BUY", 100) == pytest.approx(100.1)
    assert c.fill_price("SELL", 100) == pytest.approx(99.9)
    assert c.commission(10, 100) == 1.0          # Mindestgebühr
    assert c.commission(1000, 100) == pytest.approx(5.0)


def test_round_trip_accounting_includes_fees_and_slippage():
    b = broker()
    b.open_position("AAPL", "LONG", 10, 100.0, TS, 95.0, 110.0)
    assert b.cash == pytest.approx(10_000 - 10 * 100.1 - 1.0)
    trade = b.close_position("AAPL", 105.0, TS, "test")
    expected = 10 * (104.895 - 100.1) - 2.0
    assert trade["pnl"] == pytest.approx(expected, abs=0.01)
    assert b.equity == pytest.approx(10_000 + expected, abs=0.01)
    assert len(b.ledger.transactions()) == 2 and len(b.ledger.trades()) == 1


def test_stop_loss_take_profit_and_gap():
    b = broker(slippage=0)
    b.open_position("X", "LONG", 10, 100, TS, 95, 110)
    assert b.on_bar("X", TS, 100, 104, 96, 101) is None
    t = b.on_bar("X", TS, 101, 102, 94, 95)
    assert t["exit_reason"] == "Stop-Loss" and t["exit_price"] == pytest.approx(95)
    b.open_position("X", "LONG", 10, 100, TS, 95, 110)
    t = b.on_bar("X", TS, 112, 115, 111, 114)
    assert t["exit_reason"] == "Take-Profit (Gap)" and t["exit_price"] == pytest.approx(112)
    b.open_position("X", "LONG", 10, 100, TS, 95, 110)
    t = b.on_bar("X", TS, 100, 111, 94, 100)       # beide berührt -> konservativ Stop
    assert t["exit_reason"] == "Stop-Loss"


def test_short_positions():
    b = broker(slippage=0, short=True)
    b.open_position("X", "SHORT", 10, 100, TS, 105, 90)
    t = b.on_bar("X", TS, 99, 99.5, 89, 90)
    assert t["exit_reason"] == "Take-Profit" and t["pnl"] == pytest.approx(100 - 2)
    with pytest.raises(OrderRejectedError):
        broker().open_position("X", "SHORT", 1, 100, TS, 105, 90)


def test_order_validation():
    b = broker()
    with pytest.raises(OrderRejectedError):
        b.open_position("X", "LONG", 10, 100, TS, 101, 110)   # Stop über Preis
    with pytest.raises(OrderRejectedError):
        b.open_position("X", "LONG", 1000, 100, TS, 95, 110)  # zu wenig Kapital
    b.open_position("X", "LONG", 1, 100, TS, 95, 110)
    with pytest.raises(OrderRejectedError):
        b.open_position("X", "LONG", 1, 100, TS, 95, 110)     # doppelt
    with pytest.raises(OrderRejectedError):
        b.close_position("Y", 100, TS)


def test_state_persists_across_restart(tmp_path):
    led = Ledger(tmp_path / "db.sqlite")
    b = broker(ledger=led)
    b.open_position("X", "LONG", 5, 100, TS, 95, 110)
    b2 = broker(ledger=Ledger(tmp_path / "db.sqlite"))
    assert "X" in b2.positions and b2.cash == pytest.approx(b.cash)


def test_position_sizing_limits():
    r = RiskManager(RiskConfig(risk_per_trade=0.01, max_position_pct=0.2))
    s = r.position_size(100_000, 100_000, 100, 98, confidence=1.0)   # Risiko 1000 / 2 = 500 Stk -> Limit 200
    assert s.qty == 200 and "Positionsgröße" in s.reason
    s = r.position_size(100_000, 100_000, 100, 90, confidence=1.0)   # 1000/10 = 100 Stk
    assert s.qty == 100 and s.risk_amount == pytest.approx(1000)
    s = r.position_size(100_000, 100_000, 100, 90, confidence=0.0)   # halbes Risiko
    assert s.qty == 50
    s = r.position_size(100_000, 1_000, 100, 90)                      # Bargeld begrenzt
    assert s.qty == 9
    assert r.position_size(100_000, 100_000, 100, 100).qty == 0


def test_kill_switches():
    r = RiskManager(RiskConfig(daily_loss_limit=0.03, max_drawdown_limit=0.1, max_open_positions=2))
    assert r.can_open(0, -0.01, 0.02)[0]
    assert not r.can_open(0, -0.031, 0.0)[0]
    assert not r.can_open(0, 0.0, 0.11)[0]
    assert not r.can_open(2, 0.0, 0.0)[0]


def test_metrics():
    eq = pd.Series([100, 110, 99, 120, 108], dtype=float)
    m = equity_metrics(eq, periods_per_year=252)
    assert m["total_return_pct"] == pytest.approx(8.0)
    assert m["max_drawdown_pct"] == pytest.approx(-10.0)
    t = trade_metrics([{"pnl": 100, "fees": 1}, {"pnl": -50, "fees": 1}, {"pnl": 30, "fees": 1}])
    assert t["trades"] == 3 and t["win_rate_pct"] == pytest.approx(66.6667, abs=0.01)
    assert t["profit_factor"] == pytest.approx(2.6)
    assert trade_metrics([])["trades"] == 0
