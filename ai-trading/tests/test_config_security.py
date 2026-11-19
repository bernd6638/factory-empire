import json

import pytest

from trading_system.config import Settings, enforce_paper, load_settings
from trading_system.errors import ConfigError, LiveTradingForbiddenError, SecretStoreError
from trading_system.secret_store import SecretVault, get_secret, mask, secrets_status
from trading_system.trading.broker import PaperBroker


@pytest.mark.parametrize("mode", ["live", "LIVE", "real", ""])
def test_only_paper_mode_allowed(mode):
    with pytest.raises(LiveTradingForbiddenError):
        enforce_paper(mode)
    with pytest.raises(LiveTradingForbiddenError):
        Settings(trading_mode=mode).validate()


def test_live_env_flag_blocks(monkeypatch):
    monkeypatch.setenv("TS_LIVE_TRADING", "true")
    with pytest.raises(LiveTradingForbiddenError):
        enforce_paper("paper")


def test_broker_cannot_be_switched_to_live():
    class Sneaky(PaperBroker):
        mode = "live"

    from trading_system.config import CostConfig
    from trading_system.trading.costs import CostModel
    with pytest.raises(LiveTradingForbiddenError):
        Sneaky(1000, CostModel(CostConfig()))


def test_no_live_order_code_paths():
    """Sicherheitsnetz: kein Modul darf Order-Endpunkte eines Brokers ansprechen."""
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent / "trading_system"
    forbidden = ["/v2/orders", "api.alpaca.markets", "paper-api.alpaca.markets/v2/orders", "submit_order"]
    for f in root.rglob("*.py"):
        text = f.read_text("utf-8")
        for token in forbidden:
            assert token not in text, f"{token} in {f}"


def test_validation_rejects_leverage_and_bad_values():
    s = Settings()
    s.risk.max_gross_exposure = 2.0
    with pytest.raises(ConfigError):
        s.validate()
    with pytest.raises(ConfigError):
        Settings(initial_capital=0).validate()


def test_load_settings_file_and_env(tmp_path):
    cfg = tmp_path / "c.json"
    cfg.write_text(json.dumps({"symbols": ["tsla"], "risk": {"risk_per_trade": 0.005}}))
    s = load_settings(cfg, env={"TS_INITIAL_CAPITAL": "5000", "TS_COST_SLIPPAGE_BPS": "2.5"})
    assert s.symbols == ["TSLA"] and s.risk.risk_per_trade == 0.005
    assert s.initial_capital == 5000 and s.costs.slippage_bps == 2.5
    with pytest.raises(LiveTradingForbiddenError):
        load_settings(cfg, env={"TS_TRADING_MODE": "live"})


def test_vault_roundtrip_and_wrong_password(tmp_path):
    p = tmp_path / "s.vault"
    v = SecretVault(p, "korrekt-pferd-batterie")
    v.set("ALPACA_API_KEY", "PKTEST123456")
    assert "PKTEST123456" not in p.read_text()  # verschlüsselt gespeichert
    assert SecretVault(p, "korrekt-pferd-batterie").get("ALPACA_API_KEY") == "PKTEST123456"
    with pytest.raises(SecretStoreError):
        SecretVault(p, "falsch").get("ALPACA_API_KEY")
    assert v.delete("ALPACA_API_KEY") and v.names() == []


def test_get_secret_priority(tmp_path, monkeypatch):
    p = tmp_path / "s.vault"
    SecretVault(p, "pw").set("ALPHAVANTAGE_API_KEY", "from-vault")
    assert get_secret("ALPHAVANTAGE_API_KEY", p) is None          # kein Passwort -> kein Zugriff
    monkeypatch.setenv("TS_VAULT_PASSWORD", "pw")
    assert get_secret("ALPHAVANTAGE_API_KEY", p) == "from-vault"
    monkeypatch.setenv("ALPHAVANTAGE_API_KEY", "from-env")
    assert get_secret("ALPHAVANTAGE_API_KEY", p) == "from-env"
    st = secrets_status(p)
    assert st["ALPHAVANTAGE_API_KEY"]["configured"] and "from-env" not in st["ALPHAVANTAGE_API_KEY"]["masked"]


def test_mask():
    assert mask(None) == "<nicht gesetzt>"
    assert mask("abcdefghijkl") == "abc…kl"


def test_load_dotenv(tmp_path, monkeypatch):
    from trading_system.config import load_dotenv
    f = tmp_path / ".env"
    f.write_text("# Kommentar\nALPHAVANTAGE_API_KEY='abc'\nEMPTY=\nTS_VAULT_PASSWORD=keep\n")
    monkeypatch.setenv("TS_VAULT_PASSWORD", "existing")
    assert load_dotenv(f) == 1
    import os
    assert os.environ["ALPHAVANTAGE_API_KEY"] == "abc" and os.environ["TS_VAULT_PASSWORD"] == "existing"
    del os.environ["ALPHAVANTAGE_API_KEY"]
