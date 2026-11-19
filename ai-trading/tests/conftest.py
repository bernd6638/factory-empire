import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from trading_system.config import Settings  # noqa: E402
from trading_system.data.simulated import SimulatedProvider  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in ("TS_LIVE_TRADING", "LIVE_TRADING", "ALPACA_API_KEY", "ALPACA_API_SECRET", "ALPHAVANTAGE_API_KEY",
              "ANTHROPIC_API_KEY", "TS_VAULT_PASSWORD", "TS_CONFIG"):
        monkeypatch.delenv(k, raising=False)


@pytest.fixture
def settings(tmp_path):
    return Settings(db_path=":memory:", journal_path=str(tmp_path / "j.jsonl"), vault_path=str(tmp_path / "v.vault"),
                    data_provider="simulated", symbols=["AAPL", "MSFT"]).validate()


@pytest.fixture
def provider():
    return SimulatedProvider(seed=7, live=False)


def make_bars(close, start="2026-03-02 14:30", freq="5min", spread=0.002, volume=1000):
    close = np.asarray(close, dtype=float)
    idx = pd.date_range(start, periods=len(close), freq=freq, tz="UTC")
    open_ = np.concatenate([[close[0]], close[:-1]])
    return pd.DataFrame({"open": open_, "high": np.maximum(open_, close) * (1 + spread),
                         "low": np.minimum(open_, close) * (1 - spread), "close": close,
                         "volume": np.full(len(close), volume)}, index=idx)


@pytest.fixture
def trend_bars():
    rng = np.random.default_rng(1)
    return make_bars(100 * np.exp(np.cumsum(0.001 + rng.normal(0, 0.002, 400))))
