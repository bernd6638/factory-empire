"""Optionaler KI-Marktkommentar über die Claude API.

Der Kommentar ist rein beschreibend: Er erklärt die Analyse in natürlicher
Sprache, beeinflusst aber KEINE Handelsentscheidung (die Engine bleibt
deterministisch und reproduzierbar). Ohne ``ANTHROPIC_API_KEY`` oder ohne
installiertes ``anthropic``-Paket ist die Funktion einfach deaktiviert.
"""

from __future__ import annotations

import json
import logging
import time

log = logging.getLogger(__name__)

SYSTEM_PROMPT = (
    "Du bist ein nüchterner Marktanalyst für ein Paper-Trading-Lernsystem. "
    "Fasse die gelieferte technische Analyse und die Entscheidung des regelbasierten Systems "
    "in 3–5 kurzen deutschen Sätzen zusammen: Lage, wichtigste Signale, Hauptrisiken. "
    "Gib keine Kauf- oder Verkaufsempfehlung ab, versprich keine Gewinne und erfinde keine "
    "Nachrichten oder Zahlen, die nicht in den Daten stehen."
)


class LLMAnalyst:
    def __init__(self, api_key: str | None, model: str = "claude-opus-5-5", effort: str = "low",
                 min_interval_sec: float = 300.0, client=None):
        self.model = model
        self.effort = effort
        self.min_interval = min_interval_sec
        self._cache: dict[str, tuple[float, str]] = {}
        self.client = client
        self.error: str | None = None
        if self.client is None and api_key:
            try:
                import anthropic
                self.client = anthropic.Anthropic(api_key=api_key, max_retries=2, timeout=60)
            except ImportError:
                self.error = "Paket 'anthropic' nicht installiert"

    @property
    def enabled(self) -> bool:
        return self.client is not None

    def commentary(self, symbol: str, analysis: dict, decision: dict) -> str | None:
        if not self.enabled:
            return None
        hit = self._cache.get(symbol)
        if hit and time.monotonic() - hit[0] < self.min_interval:
            return hit[1]
        payload = {
            "analyse": {k: analysis.get(k) for k in ("symbol", "price", "trend", "trend_strength", "adx",
                                                    "volatility_regime", "atr_pct", "rsi", "macd_hist",
                                                    "bb_pct_b", "mtf_alignment", "anomalies", "timeframes")},
            "entscheidung": {k: decision.get(k) for k in ("action", "ensemble_score", "confidence", "reasons", "risk")},
        }
        try:
            import anthropic
            resp = self.client.beta.messages.create(
                model=self.model,
                max_tokens=2000,
                system=SYSTEM_PROMPT,
                output_config={"effort": self.effort},
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False, default=str)}],
            )
            if resp.stop_reason == "refusal":
                self.error = "Anfrage vom Modell abgelehnt"
                return None
            text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
            self.error = None
            self._cache[symbol] = (time.monotonic(), text)
            return text or None
        except anthropic.AuthenticationError:
            self.error = "ANTHROPIC_API_KEY ungültig"
            self.client = None  # nicht weiter versuchen
        except anthropic.RateLimitError:
            self.error = "Rate-Limit erreicht – später erneut"
        except anthropic.APIStatusError as exc:
            self.error = f"API-Fehler {exc.status_code}"
        except anthropic.APIConnectionError:
            self.error = "Keine Verbindung zur Claude API"
        except Exception as exc:  # noqa: BLE001 - Kommentar ist optional, darf nie den Handel stoppen
            self.error = f"Unerwarteter Fehler: {type(exc).__name__}"
        log.warning("LLM-Kommentar fehlgeschlagen: %s", self.error)
        return None
