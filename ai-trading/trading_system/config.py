"""Konfiguration. Paper-Trading ist hart erzwungen.

Werte kommen aus (aufsteigende Priorität): Defaults -> ``config.json`` -> Umgebungsvariablen ``TS_*``.
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

from .errors import ConfigError, LiveTradingForbiddenError

BASE_DIR = Path(__file__).resolve().parent.parent
PAPER = "paper"


@dataclass
class RiskConfig:
    risk_per_trade: float = 0.01        # Anteil des Eigenkapitals, der pro Trade riskiert wird
    max_position_pct: float = 0.20      # max. Positionswert relativ zum Eigenkapital
    max_gross_exposure: float = 1.0     # max. Summe aller Positionswerte / Eigenkapital (kein Hebel)
    max_open_positions: int = 5
    daily_loss_limit: float = 0.03      # Kill-Switch: bei -3 % Tagesverlust keine neuen Trades
    max_drawdown_limit: float = 0.15    # Kill-Switch bei -15 % vom Hoch
    atr_stop_mult: float = 2.0          # Stop-Loss = Entry - k * ATR
    reward_risk: float = 2.0            # Take-Profit = Entry + R * (Entry - Stop)
    allow_short: bool = False


@dataclass
class CostConfig:
    commission_per_share: float = 0.005
    commission_min: float = 1.0
    commission_pct: float = 0.0
    slippage_bps: float = 5.0           # 0,05 % ungünstigere Ausführung


@dataclass
class Settings:
    trading_mode: str = PAPER
    initial_capital: float = 100_000.0
    symbols: list[str] = field(default_factory=lambda: ["AAPL", "MSFT", "NVDA", "SPY", "QQQ"])
    data_provider: str = "auto"         # auto | simulated | yahoo | alpaca | alphavantage
    timeframe: str = "5m"               # Basis-Intervall für Entscheidungen
    confirm_timeframes: list[str] = field(default_factory=lambda: ["15m", "1h"])
    lookback_bars: int = 300
    loop_interval_sec: float = 60.0
    min_confidence: float = 0.55
    db_path: str = str(BASE_DIR / "data" / "trading.db")
    journal_path: str = str(BASE_DIR / "data" / "decisions.jsonl")
    vault_path: str = str(BASE_DIR / "data" / "secrets.vault")
    llm_enabled: bool = False
    llm_model: str = "claude-opus-5-5"
    llm_effort: str = "low"
    sim_seed: int = 42
    risk: RiskConfig = field(default_factory=RiskConfig)
    costs: CostConfig = field(default_factory=CostConfig)

    def validate(self) -> "Settings":
        enforce_paper(self.trading_mode)
        if self.initial_capital <= 0:
            raise ConfigError("initial_capital muss > 0 sein")
        if not self.symbols:
            raise ConfigError("Mindestens ein Symbol erforderlich")
        if not 0 < self.risk.risk_per_trade <= 0.05:
            raise ConfigError("risk_per_trade muss zwischen 0 und 5 % liegen")
        if not 0 < self.risk.max_position_pct <= 1:
            raise ConfigError("max_position_pct muss in (0, 1] liegen")
        if self.risk.max_gross_exposure > 1.0:
            raise ConfigError("Hebel (max_gross_exposure > 1) ist nicht erlaubt")
        if self.costs.slippage_bps < 0 or self.costs.commission_per_share < 0:
            raise ConfigError("Kosten dürfen nicht negativ sein")
        if self.lookback_bars < 60:
            raise ConfigError("lookback_bars muss >= 60 sein")
        self.symbols = [s.strip().upper() for s in self.symbols if s.strip()]
        return self

    def to_dict(self) -> dict:
        return asdict(self)


def enforce_paper(mode: str) -> None:
    """Einzige erlaubte Betriebsart ist 'paper'. Alles andere bricht hart ab."""
    if str(mode).strip().lower() != PAPER:
        raise LiveTradingForbiddenError(
            f"Betriebsart '{mode}' ist gesperrt. Dieses System unterstützt ausschließlich Paper-Trading."
        )
    for var in ("TS_LIVE_TRADING", "LIVE_TRADING"):
        if os.environ.get(var, "").strip().lower() in {"1", "true", "yes", "on"}:
            raise LiveTradingForbiddenError(f"{var} ist gesetzt – Echtgeldhandel ist nicht freigegeben.")


def load_dotenv(path: str | Path | None = None) -> int:
    """Liest ``KEY=VALUE``-Zeilen aus ``.env`` in die Umgebung (bestehende Variablen haben Vorrang)."""
    p = Path(path) if path else BASE_DIR / ".env"
    if not p.exists():
        return 0
    n = 0
    for line in p.read_text("utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and v and k not in os.environ:
            os.environ[k] = v
            n += 1
    return n


def _coerce(value: str, current):
    if isinstance(current, bool):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    if isinstance(current, int):
        return int(value)
    if isinstance(current, float):
        return float(value)
    if isinstance(current, list):
        return [v.strip() for v in value.split(",") if v.strip()]
    return value


def _apply(obj, data: dict) -> None:
    for f in fields(obj):
        if f.name not in data:
            continue
        cur = getattr(obj, f.name)
        if isinstance(cur, (RiskConfig, CostConfig)):
            _apply(cur, data[f.name])
        else:
            setattr(obj, f.name, data[f.name])


def load_settings(path: str | Path | None = None, env: dict | None = None) -> Settings:
    env = os.environ if env is None else env
    s = Settings()
    cfg_path = Path(path) if path else Path(env.get("TS_CONFIG", BASE_DIR / "config.json"))
    if cfg_path.exists():
        try:
            _apply(s, json.loads(cfg_path.read_text("utf-8")))
        except (json.JSONDecodeError, TypeError) as exc:
            raise ConfigError(f"config.json ungültig: {exc}") from exc
    for f in fields(s):
        key = f"TS_{f.name.upper()}"
        if key in env and not isinstance(getattr(s, f.name), (RiskConfig, CostConfig)):
            try:
                setattr(s, f.name, _coerce(env[key], getattr(s, f.name)))
            except ValueError as exc:
                raise ConfigError(f"{key}: {exc}") from exc
    for sub, prefix in ((s.risk, "TS_RISK_"), (s.costs, "TS_COST_")):
        for f in fields(sub):
            key = prefix + f.name.upper()
            if key in env:
                setattr(sub, f.name, _coerce(env[key], getattr(sub, f.name)))
    return s.validate()
