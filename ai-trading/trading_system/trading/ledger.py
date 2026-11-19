"""SQLite-Persistenz: Transaktionsprotokoll, abgeschlossene Trades, Equity-Kurve, Zustand."""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, qty REAL NOT NULL,
    ref_price REAL NOT NULL, fill_price REAL NOT NULL, commission REAL NOT NULL,
    slippage_cost REAL NOT NULL, reason TEXT, decision_id TEXT, cash_after REAL
);
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL, side TEXT NOT NULL, qty REAL NOT NULL,
    entry_ts TEXT, entry_price REAL, exit_ts TEXT, exit_price REAL,
    pnl REAL, pnl_pct REAL, fees REAL, exit_reason TEXT, decision_id TEXT
);
CREATE TABLE IF NOT EXISTS equity (
    ts TEXT PRIMARY KEY, equity REAL NOT NULL, cash REAL NOT NULL, exposure REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


class Ledger:
    def __init__(self, path: str | Path = ":memory:"):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        with self._lock:
            self.conn.executescript(SCHEMA)
            self.conn.execute("PRAGMA journal_mode=WAL") if self.path != ":memory:" else None
            self.conn.commit()

    def _exec(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        with self._lock:
            cur = self.conn.execute(sql, params)
            self.conn.commit()
            return cur

    def _query(self, sql: str, params: tuple = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def add_transaction(self, **t) -> int:
        cols = ["ts", "symbol", "side", "qty", "ref_price", "fill_price", "commission", "slippage_cost",
                "reason", "decision_id", "cash_after"]
        return self._exec(f"INSERT INTO transactions ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                          tuple(t.get(c) for c in cols)).lastrowid

    def add_trade(self, **t) -> int:
        cols = ["symbol", "side", "qty", "entry_ts", "entry_price", "exit_ts", "exit_price", "pnl", "pnl_pct",
                "fees", "exit_reason", "decision_id"]
        return self._exec(f"INSERT INTO trades ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                          tuple(t.get(c) for c in cols)).lastrowid

    def add_equity(self, ts: str, equity: float, cash: float, exposure: float) -> None:
        self._exec("INSERT OR REPLACE INTO equity (ts, equity, cash, exposure) VALUES (?,?,?,?)",
                   (ts, equity, cash, exposure))

    def transactions(self, limit: int = 200) -> list[dict]:
        return self._query("SELECT * FROM transactions ORDER BY id DESC LIMIT ?", (limit,))

    def trades(self, limit: int = 1000) -> list[dict]:
        return self._query("SELECT * FROM trades ORDER BY id DESC LIMIT ?", (limit,))

    def equity_curve(self, limit: int = 5000) -> list[dict]:
        rows = self._query("SELECT * FROM equity ORDER BY ts DESC LIMIT ?", (limit,))
        return list(reversed(rows))

    def save_state(self, key: str, value) -> None:
        self._exec("INSERT OR REPLACE INTO state (k, v) VALUES (?, ?)", (key, json.dumps(value, default=str)))

    def load_state(self, key: str, default=None):
        rows = self._query("SELECT v FROM state WHERE k = ?", (key,))
        return json.loads(rows[0]["v"]) if rows else default

    def reset(self) -> None:
        with self._lock:
            for t in ("transactions", "trades", "equity", "state"):
                self.conn.execute(f"DELETE FROM {t}")
            self.conn.commit()
