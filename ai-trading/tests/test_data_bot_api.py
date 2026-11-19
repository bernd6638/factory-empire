from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from trading_system.ai.llm_analyst import LLMAnalyst
from trading_system.api.server import create_app
from trading_system.backtest.backtester import Backtester
from trading_system.bot import TradingBot
from trading_system.data.base import CachedProvider, FallbackProvider, MarketDataProvider, validate_bars
from trading_system.data.providers import AlpacaDataProvider, AlphaVantageProvider, YahooProvider, build_provider
from trading_system.errors import DataProviderError
from trading_system.trading.ledger import Ledger


def _resp(status=200, payload=None):
    r = MagicMock()
    r.status_code = status
    r.json.return_value = payload or {}
    r.raise_for_status.return_value = None
    return r


def test_simulated_provider_shapes(provider):
    for tf in ("1m", "5m", "15m", "1h"):
        df = provider.get_bars("AAPL", tf, 120)
        assert len(df) == 120 and list(df.columns) == ["open", "high", "low", "close", "volume"]
        assert (df["high"] >= df["low"]).all() and df.index.is_monotonic_increasing
    a = provider.get_bars("AAPL", "5m", 50)
    provider.advance(10)
    b = provider.get_bars("AAPL", "5m", 50)
    assert b.index[-1] >= a.index[-1]


def test_validate_bars_cleans():
    idx = pd.date_range("2026-01-01", periods=4, freq="1min")
    df = pd.DataFrame({"open": [1, 2, 3, 4], "high": [2, 3, "x", 5], "low": [0.5, 1, 2, 6], "close": [1.5, 2.5, 3, 4.5],
                       "volume": [1, 1, 1, 1]}, index=idx)
    out = validate_bars(df, "T")
    assert len(out) == 2 and str(out.index.tz) == "UTC"
    with pytest.raises(DataProviderError):
        validate_bars(pd.DataFrame(), "T")


def test_yahoo_parsing():
    s = MagicMock()
    s.get.return_value = _resp(200, {"chart": {"result": [{"timestamp": [1767000000, 1767000060],
        "indicators": {"quote": [{"open": [1, 2], "high": [2, 3], "low": [0.5, 1.5], "close": [1.5, 2.5], "volume": [10, 20]}]}}]}})
    df = YahooProvider(session=s).get_bars("AAPL", "1m", 10)
    assert df["close"].tolist() == [1.5, 2.5]


def test_alpaca_parsing_and_pagination():
    s = MagicMock()
    s.get.side_effect = [
        _resp(200, {"bars": [{"t": "2026-01-02T15:00:00Z", "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 100}], "next_page_token": "abc"}),
        _resp(200, {"bars": [{"t": "2026-01-02T15:05:00Z", "o": 1.5, "h": 2, "l": 1, "c": 1.8, "v": 50}], "next_page_token": None}),
    ]
    df = AlpacaDataProvider("k", "s", session=s).get_bars("AAPL", "5m", 10)
    assert len(df) == 2 and s.get.call_count == 2
    assert s.get.call_args_list[0].kwargs["headers"]["APCA-API-KEY-ID"] == "k"
    assert "data.alpaca.markets" in s.get.call_args_list[0].args[0]  # nur Marktdaten-Host


def test_alpaca_auth_error_and_alphavantage_limit():
    s = MagicMock()
    s.get.return_value = _resp(403)
    with pytest.raises(DataProviderError, match="403"):
        AlpacaDataProvider("k", "s", session=s).get_bars("AAPL", "5m", 10)
    s.get.return_value = _resp(200, {"Note": "API call frequency exceeded"})
    with pytest.raises(DataProviderError, match="frequency"):
        AlphaVantageProvider("key", session=s).get_bars("AAPL", "5m", 10)


def test_fallback_and_cache(provider):
    class Bad(MarketDataProvider):
        name = "bad"

        def get_bars(self, *a):
            raise DataProviderError("down")

    bad = Bad()
    bad.get_bars = MagicMock(side_effect=DataProviderError("down"))
    fb = FallbackProvider([bad, provider])
    assert len(fb.get_bars("AAPL", "5m", 80)) == 80
    assert fb.last_used == "simulated" and "bad" in fb.errors
    fb.get_bars("AAPL", "5m", 80)
    assert bad.get_bars.call_count == 1  # Circuit-Breaker: pausiert
    calls = {"n": 0}

    class Counting(MarketDataProvider):
        name = "c"

        def get_bars(self, *a):
            calls["n"] += 1
            return provider.get_bars(*a)

    c = CachedProvider(Counting(), ttl_sec=60)
    c.get_bars("AAPL", "5m", 80)
    c.get_bars("AAPL", "5m", 80)
    assert calls["n"] == 1


def test_build_provider_respects_credentials(settings):
    settings.data_provider = "auto"
    p = build_provider(settings, lambda n: None)
    assert [x.name for x in p.inner.providers] == ["yahoo", "simulated"]
    p = build_provider(settings, lambda n: "x")
    assert [x.name for x in p.inner.providers] == ["alpaca", "alphavantage", "yahoo", "simulated"]
    settings.data_provider = "alpaca"
    with pytest.raises(DataProviderError):
        build_provider(settings, lambda n: None)


@pytest.fixture
def bot(settings, provider):
    return TradingBot(settings, provider=provider, ledger=Ledger(":memory:"), llm=LLMAnalyst(None))


def test_bot_cycle_and_isolated_errors(bot):
    bot.s.symbols = ["AAPL", "MSFT", "BROKEN!"]
    orig = bot.provider.get_bars

    def flaky(sym, tf, n):
        if sym == "BROKEN!":
            raise DataProviderError("kaputt")
        return orig(sym, tf, n)

    bot.provider.get_bars = flaky
    res = bot.run_cycle()
    assert res["ok"] == ["AAPL", "MSFT"] and res["failed"] == ["BROKEN!"]
    assert bot.errors and bot.decisions["AAPL"].action in {"BUY", "SELL", "HOLD"}
    assert bot.journal.tail(5)
    assert bot.ledger.equity_curve()


def test_bot_executes_and_respects_kill_switch(bot):
    from trading_system.ai.engine import Decision, RiskAssessment
    d = Decision("id1", "now", "AAPL", "BUY", 0.6, 0.9, 100.0, [], [], RiskAssessment(96, 108, 4, 2, 0.3), ["t"], "s")
    bot.execute(d, "2026-03-02T15:00:00+00:00")
    assert "AAPL" in bot.broker.positions
    pos = bot.broker.positions["AAPL"]
    assert pos.qty * pos.entry_price <= bot.s.initial_capital * bot.s.risk.max_position_pct + 1
    # SELL schließt die Position
    bot.execute(Decision("id2", "now", "AAPL", "SELL", -0.6, 0.9, 101.0, [], [], RiskAssessment(105, 93, 4, 2, 0.3), ["t"], "s"),
                "2026-03-02T15:05:00+00:00")
    assert "AAPL" not in bot.broker.positions
    # Kill-Switch: Tagesverlust simulieren
    bot.broker.day_start["2026-03-02"] = bot.broker.equity / 0.9
    bot.execute(d, "2026-03-02T15:10:00+00:00")
    assert "AAPL" not in bot.broker.positions
    assert any(e["kind"] == "risk" for e in bot.events)


def test_api_endpoints(bot):
    client = TestClient(create_app(bot))
    assert client.get("/api/status").json()["mode"] == "PAPER"
    assert client.get("/api/analysis/AAPL").status_code == 404
    assert client.post("/api/control/step").status_code == 200
    for path in ("/api/portfolio", "/api/signals", "/api/analysis", "/api/performance", "/api/equity",
                 "/api/transactions", "/api/trades", "/api/journal", "/api/events", "/api/bars/AAPL"):
        r = client.get(path)
        assert r.status_code == 200, path
    bars = client.get("/api/bars/AAPL").json()
    assert bars["bars"] and {"time", "close", "rsi_14"} <= set(bars["bars"][-1])
    assert client.get("/api/analysis/AAPL").json()["decision"]["disclaimer"]
    assert client.get("/api/bars/NOPE").status_code == 404
    assert client.post("/api/control/close-all").status_code == 200
    assert "AI Day Trading" in client.get("/").text
    assert client.get("/static/vendor/lightweight-charts.standalone.production.js").status_code == 200


def test_llm_analyst_mocked():
    client = MagicMock()
    client.beta.messages.create.return_value = SimpleNamespace(stop_reason="end_turn",
                                                               content=[SimpleNamespace(type="text", text="Kommentar")])
    a = LLMAnalyst(None, client=client)
    assert a.enabled and a.commentary("AAPL", {"symbol": "AAPL"}, {"action": "HOLD"}) == "Kommentar"
    kwargs = client.beta.messages.create.call_args.kwargs
    assert kwargs["model"] == "claude-opus-5-5" and kwargs["fallbacks"] == "default"
    a.commentary("AAPL", {}, {})  # gecacht
    assert client.beta.messages.create.call_count == 1
    client.beta.messages.create.return_value = SimpleNamespace(stop_reason="refusal", content=[])
    b = LLMAnalyst(None, client=client)
    assert b.commentary("X", {}, {}) is None and "abgelehnt" in b.error
    client.beta.messages.create.side_effect = RuntimeError("boom")
    c = LLMAnalyst(None, client=client)
    assert c.commentary("Y", {}, {}) is None and c.error
    assert not LLMAnalyst(None).enabled


def test_backtest_runs_and_has_no_lookahead_execution(settings, provider):
    data = {"AAPL": provider.get_bars("AAPL", "5m", 600)}
    res = Backtester(settings).run(data)
    assert len(res.equity) > 300
    assert res.trade_stats["trades"] >= 0
    for t in res.trades:
        assert t["entry_ts"] <= t["exit_ts"]
    # Einstiege erfolgen frühestens eine Kerze nach WARMUP
    idx = data["AAPL"].index
    for t in res.trades:
        assert pd.Timestamp(t["entry_ts"]) > idx[210]
    assert np.isfinite(res.metrics["sharpe"])
