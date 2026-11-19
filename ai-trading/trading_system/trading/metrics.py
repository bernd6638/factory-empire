"""Performance- und Risikokennzahlen."""

from __future__ import annotations

import numpy as np
import pandas as pd


def _safe(x: float) -> float:
    return 0.0 if x is None or np.isnan(x) or np.isinf(x) else round(float(x), 4)


def equity_metrics(equity: pd.Series, periods_per_year: float = 252 * 78, risk_free: float = 0.0) -> dict:
    """Kennzahlen aus einer Equity-Kurve (Default: 5-Minuten-Takt)."""
    equity = equity.dropna()
    if len(equity) < 2:
        return {k: 0.0 for k in ("total_return_pct", "cagr_pct", "volatility_pct", "sharpe", "sortino",
                                 "max_drawdown_pct", "calmar", "var_95_pct", "cvar_95_pct")}
    rets = equity.pct_change().dropna()
    total = equity.iloc[-1] / equity.iloc[0] - 1
    years = max(len(rets) / periods_per_year, 1e-9)
    cagr = (1 + total) ** (1 / years) - 1 if total > -1 else -1.0
    vol = rets.std() * np.sqrt(periods_per_year)
    ex = rets - risk_free / periods_per_year
    sharpe = ex.mean() / rets.std() * np.sqrt(periods_per_year) if rets.std() > 0 else 0.0
    downside = rets[rets < 0].std()
    sortino = ex.mean() / downside * np.sqrt(periods_per_year) if downside and downside > 0 else 0.0
    dd = equity / equity.cummax() - 1
    mdd = dd.min()
    var95 = np.percentile(rets, 5) if len(rets) >= 20 else 0.0
    cvar95 = rets[rets <= var95].mean() if len(rets) >= 20 else 0.0
    return {
        "total_return_pct": _safe(total * 100), "cagr_pct": _safe(min(cagr, 1e6) * 100),
        "volatility_pct": _safe(vol * 100), "sharpe": _safe(sharpe), "sortino": _safe(sortino),
        "max_drawdown_pct": _safe(mdd * 100), "calmar": _safe(cagr / abs(mdd)) if mdd < 0 else 0.0,
        "var_95_pct": _safe(var95 * 100), "cvar_95_pct": _safe(cvar95 * 100),
    }


def trade_metrics(trades: list[dict]) -> dict:
    if not trades:
        return {"trades": 0, "win_rate_pct": 0.0, "profit_factor": 0.0, "avg_win": 0.0, "avg_loss": 0.0,
                "expectancy": 0.0, "best_trade": 0.0, "worst_trade": 0.0, "total_fees": 0.0, "net_pnl": 0.0}
    pnl = np.array([t["pnl"] for t in trades], dtype=float)
    wins, losses = pnl[pnl > 0], pnl[pnl <= 0]
    gross_loss = abs(losses.sum())
    return {
        "trades": int(len(pnl)), "win_rate_pct": _safe(len(wins) / len(pnl) * 100),
        "profit_factor": _safe(wins.sum() / gross_loss) if gross_loss > 0 else (99.0 if wins.sum() > 0 else 0.0),
        "avg_win": _safe(wins.mean()) if len(wins) else 0.0, "avg_loss": _safe(losses.mean()) if len(losses) else 0.0,
        "expectancy": _safe(pnl.mean()), "best_trade": _safe(pnl.max()), "worst_trade": _safe(pnl.min()),
        "total_fees": _safe(sum(t.get("fees") or 0 for t in trades)), "net_pnl": _safe(pnl.sum()),
    }
