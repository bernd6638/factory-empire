"""Echte Marktdatenanbieter (HTTP). Nur Lesezugriff – keine Orders.

* ``AlpacaDataProvider`` – Alpaca Market Data API v2 (IEX-Feed, kostenlos mit Konto)
* ``AlphaVantageProvider`` – Alpha Vantage TIME_SERIES_INTRADAY
* ``YahooProvider`` – inoffizieller Yahoo-Chart-Endpunkt ohne Schlüssel (verzögert)
"""

from __future__ import annotations

import time
from typing import Callable

import pandas as pd
import requests

from ..errors import DataProviderError
from .base import MarketDataProvider, tf_minutes, validate_bars

DEFAULT_TIMEOUT = 10


def _get_json(session: requests.Session, url: str, *, params=None, headers=None, retries: int = 3) -> dict:
    """GET mit Retry/Backoff für 429/5xx und Netzwerkfehler."""
    last: Exception | None = None
    for attempt in range(retries):
        try:
            r = session.get(url, params=params, headers=headers, timeout=DEFAULT_TIMEOUT)
            if r.status_code == 429 or r.status_code >= 500:
                last = DataProviderError(f"HTTP {r.status_code} von {url}")
                time.sleep(min(2**attempt, 8) * 0.5)
                continue
            if r.status_code in (401, 403):
                raise DataProviderError(f"HTTP {r.status_code}: Zugangsdaten ungültig oder Host gesperrt ({url})")
            r.raise_for_status()
            return r.json()
        except DataProviderError:
            raise
        except (requests.RequestException, ValueError) as exc:
            last = exc
            time.sleep(min(2**attempt, 8) * 0.5)
    raise DataProviderError(f"Anfrage fehlgeschlagen: {last}")


class AlpacaDataProvider(MarketDataProvider):
    name = "alpaca"
    is_realtime = True
    URL = "https://data.alpaca.markets/v2/stocks/{symbol}/bars"
    TF = {"1m": "1Min", "5m": "5Min", "15m": "15Min", "30m": "30Min", "1h": "1Hour", "4h": "4Hour", "1d": "1Day"}

    def __init__(self, key_id: str, secret: str, feed: str = "iex", session: requests.Session | None = None):
        if not key_id or not secret:
            raise DataProviderError("Alpaca: ALPACA_API_KEY/ALPACA_API_SECRET fehlen")
        self._headers = {"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret}
        self.feed = feed
        self.session = session or requests.Session()

    def get_bars(self, symbol: str, timeframe: str, limit: int) -> pd.DataFrame:
        minutes = tf_minutes(timeframe)
        start = pd.Timestamp.now(tz="UTC") - pd.Timedelta(minutes=minutes * limit * 4 + 60 * 24 * 5)
        params = {"timeframe": self.TF[timeframe], "start": start.isoformat(), "limit": 10000,
                  "feed": self.feed, "adjustment": "split"}
        rows: list[dict] = []
        url = self.URL.format(symbol=symbol)
        for _ in range(10):  # Paginierung
            data = _get_json(self.session, url, params=params, headers=self._headers)
            rows.extend(data.get("bars") or [])
            token = data.get("next_page_token")
            if not token:
                break
            params["page_token"] = token
        if not rows:
            raise DataProviderError(f"Alpaca: keine Kerzen für {symbol}")
        df = pd.DataFrame(rows).rename(columns={"o": "open", "h": "high", "l": "low", "c": "close", "v": "volume"})
        df.index = pd.to_datetime(df["t"], utc=True)
        return validate_bars(df, symbol).iloc[-limit:]


class AlphaVantageProvider(MarketDataProvider):
    name = "alphavantage"
    is_realtime = False
    URL = "https://www.alphavantage.co/query"
    TF = {"1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "60min"}

    def __init__(self, api_key: str, session: requests.Session | None = None):
        if not api_key:
            raise DataProviderError("Alpha Vantage: ALPHAVANTAGE_API_KEY fehlt")
        self.api_key = api_key
        self.session = session or requests.Session()

    def get_bars(self, symbol: str, timeframe: str, limit: int) -> pd.DataFrame:
        if timeframe == "1d":
            params = {"function": "TIME_SERIES_DAILY", "symbol": symbol, "outputsize": "full", "apikey": self.api_key}
        elif timeframe in self.TF:
            params = {"function": "TIME_SERIES_INTRADAY", "symbol": symbol, "interval": self.TF[timeframe],
                      "outputsize": "full", "apikey": self.api_key}
        else:
            raise DataProviderError(f"Alpha Vantage unterstützt {timeframe} nicht")
        data = _get_json(self.session, self.URL, params=params)
        for msg_key in ("Note", "Information", "Error Message"):
            if msg_key in data:
                raise DataProviderError(f"Alpha Vantage: {data[msg_key]}")
        key = next((k for k in data if k.startswith("Time Series")), None)
        if not key:
            raise DataProviderError("Alpha Vantage: unerwartete Antwort")
        df = pd.DataFrame.from_dict(data[key], orient="index")
        df.columns = [c.split(". ", 1)[-1] for c in df.columns]
        df.index = pd.to_datetime(df.index).tz_localize("US/Eastern").tz_convert("UTC")
        return validate_bars(df, symbol).iloc[-limit:]


class YahooProvider(MarketDataProvider):
    name = "yahoo"
    is_realtime = False
    URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    TF = {"1m": ("1m", "5d"), "5m": ("5m", "30d"), "15m": ("15m", "30d"), "30m": ("30m", "30d"),
          "1h": ("60m", "180d"), "1d": ("1d", "5y")}

    def __init__(self, session: requests.Session | None = None):
        self.session = session or requests.Session()

    def get_bars(self, symbol: str, timeframe: str, limit: int) -> pd.DataFrame:
        if timeframe not in self.TF:
            raise DataProviderError(f"Yahoo unterstützt {timeframe} nicht")
        interval, rng = self.TF[timeframe]
        data = _get_json(self.session, self.URL.format(symbol=symbol), params={"interval": interval, "range": rng},
                         headers={"User-Agent": "Mozilla/5.0 (paper-trading-research)"})
        try:
            res = data["chart"]["result"][0]
            q = res["indicators"]["quote"][0]
            df = pd.DataFrame({k: q[k] for k in ("open", "high", "low", "close", "volume")},
                              index=pd.to_datetime(res["timestamp"], unit="s", utc=True))
        except (KeyError, IndexError, TypeError) as exc:
            err = (data.get("chart") or {}).get("error")
            raise DataProviderError(f"Yahoo: unerwartete Antwort ({err or exc})") from exc
        return validate_bars(df, symbol).iloc[-limit:]


def build_provider(settings, secret_getter: Callable[[str], str | None]) -> MarketDataProvider:
    """Erstellt die Anbieterkette gemäß ``settings.data_provider``."""
    from .base import CachedProvider, FallbackProvider
    from .simulated import SimulatedProvider

    choice = settings.data_provider.lower()
    sim = SimulatedProvider(seed=settings.sim_seed)
    if choice == "simulated":
        return sim

    chain: list[MarketDataProvider] = []
    ak, asec = secret_getter("ALPACA_API_KEY"), secret_getter("ALPACA_API_SECRET")
    av = secret_getter("ALPHAVANTAGE_API_KEY")
    if choice in ("auto", "alpaca") and ak and asec:
        chain.append(AlpacaDataProvider(ak, asec))
    if choice in ("auto", "alphavantage") and av:
        chain.append(AlphaVantageProvider(av))
    if choice in ("auto", "yahoo"):
        chain.append(YahooProvider())
    if choice not in ("auto", "alpaca", "alphavantage", "yahoo"):
        raise DataProviderError(f"Unbekannter Datenanbieter '{settings.data_provider}'")
    if choice != "auto" and not chain:
        raise DataProviderError(f"Anbieter '{choice}' gewählt, aber Zugangsdaten fehlen")
    chain.append(sim)  # immer als letzter Fallback – im Dashboard deutlich markiert
    return CachedProvider(FallbackProvider(chain), ttl_sec=15)
