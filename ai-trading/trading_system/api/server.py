"""REST-API + Dashboard (FastAPI). Lauscht standardmäßig nur auf 127.0.0.1."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .. import __version__
from ..analysis.indicators import add_all
from ..bot import TradingBot
from ..errors import TradingSystemError
from ..secret_store import secrets_status

log = logging.getLogger(__name__)
DASHBOARD_DIR = Path(__file__).resolve().parent.parent / "dashboard"


def _clean(v):
    if isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
        return None
    return v


def create_app(bot: TradingBot, autostart: bool = False) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app):
        if autostart:
            bot.start()
        yield
        if bot.running:
            bot.stop()

    app = FastAPI(title="AI Paper Trading System", version=__version__, lifespan=lifespan)

    @app.exception_handler(TradingSystemError)
    def _ts_error(_req, exc: TradingSystemError):
        return JSONResponse(status_code=400, content={"error": type(exc).__name__, "detail": str(exc)})

    @app.get("/api/status")
    def status():
        prov = bot.provider
        inner = getattr(prov, "inner", prov)
        return {
            "version": __version__, "mode": "PAPER", "running": bot.running, "cycles": bot.cycles,
            "last_cycle": bot.last_cycle, "symbols": bot.s.symbols, "timeframe": bot.s.timeframe,
            "confirm_timeframes": bot.s.confirm_timeframes, "loop_interval_sec": bot.s.loop_interval_sec,
            "data_provider": getattr(inner, "last_used", None) or inner.name,
            "provider_chain": inner.name, "provider_errors": getattr(inner, "errors", {}),
            "simulated_data": (getattr(inner, "last_used", None) or inner.name) == "simulated",
            "llm_enabled": bool(bot.llm and bot.llm.enabled), "llm_error": bot.llm.error if bot.llm else None,
            "credentials": secrets_status(bot.s.vault_path),
        }

    @app.get("/api/portfolio")
    def portfolio():
        return bot.broker.snapshot()

    @app.get("/api/performance")
    def performance():
        return bot.performance()

    @app.get("/api/equity")
    def equity(limit: int = Query(2000, ge=1, le=20000)):
        return bot.ledger.equity_curve(limit)

    @app.get("/api/transactions")
    def transactions(limit: int = Query(200, ge=1, le=5000)):
        return bot.ledger.transactions(limit)

    @app.get("/api/trades")
    def trades(limit: int = Query(200, ge=1, le=5000)):
        return bot.ledger.trades(limit)

    @app.get("/api/signals")
    def signals():
        return [d.to_dict() for d in bot.decisions.values()]

    @app.get("/api/analysis")
    def analysis_all():
        return [a.to_dict() for a in bot.analyses.values()]

    @app.get("/api/analysis/{symbol}")
    def analysis(symbol: str):
        symbol = symbol.upper()
        if symbol not in bot.analyses:
            raise HTTPException(404, f"Keine Analyse für {symbol} – erst einen Zyklus ausführen")
        return {"analysis": bot.analyses[symbol].to_dict(),
                "decision": bot.decisions[symbol].to_dict() if symbol in bot.decisions else None}

    @app.get("/api/bars/{symbol}")
    def bars(symbol: str, limit: int = Query(300, ge=10, le=2000)):
        symbol = symbol.upper()
        df = bot.bars.get(symbol)
        if df is None:
            if symbol not in bot.s.symbols:
                raise HTTPException(404, f"Unbekanntes Symbol {symbol}")
            df = bot.provider.get_bars(symbol, bot.s.timeframe, bot.s.lookback_bars)
        ind = add_all(df).iloc[-limit:]
        cols = ["open", "high", "low", "close", "volume", "ema_9", "ema_21", "sma_50", "bb_upper", "bb_lower",
                "rsi_14", "macd", "macd_signal", "macd_hist"]
        out = []
        for ts, row in ind[cols].iterrows():
            rec = {"time": int(pd.Timestamp(ts).timestamp())}
            rec.update({c: _clean(float(row[c])) for c in cols})
            out.append(rec)
        pos = bot.broker.positions.get(symbol)
        markers = [t for t in bot.ledger.transactions(500) if t["symbol"] == symbol]
        return {"symbol": symbol, "bars": out, "position": pos.to_dict() if pos else None, "transactions": markers}

    @app.get("/api/journal")
    def journal(limit: int = Query(50, ge=1, le=500)):
        return bot.journal.tail(limit)

    @app.get("/api/events")
    def events():
        return {"events": list(bot.events), "errors": list(bot.errors)}

    @app.post("/api/control/start")
    def start():
        bot.start()
        return {"running": bot.running}

    @app.post("/api/control/stop")
    def stop():
        bot.stop()
        return {"running": bot.running}

    @app.post("/api/control/step")
    def step():
        return bot.run_cycle()

    @app.post("/api/control/close-all")
    def close_all():
        return {"closed": bot.close_all()}

    @app.get("/")
    def index():
        return FileResponse(DASHBOARD_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=DASHBOARD_DIR), name="static")
    return app
