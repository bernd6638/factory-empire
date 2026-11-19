"""KI-Entscheidungs-Engine.

Ablauf je Symbol:
1. Jede Strategie berechnet ihre Score-Serie.
2. **Adaptive Gewichtung**: Für jede Strategie wird auf der jüngeren Historie
   gemessen, wie gut ihre Scores die nachfolgende Rendite vorhergesagt haben
   (Rang-Korrelation = Information Coefficient, nur bereits bekannte Zukunft).
   Gute Strategien bekommen mehr Gewicht (Softmax), schlechte werden gedämpft.
3. Ensemble-Score = gewichtete Summe.
4. Kontextfilter: Multi-Timeframe-Übereinstimmung, Volatilitätsregime,
   Anomalien, Übereinstimmung der Strategien -> Konfidenz.
5. Risikobewertung: Stop-Abstand (ATR), Chance/Risiko, Risiko-Score.
6. Entscheidung BUY/SELL/HOLD mit vollständiger, nachvollziehbarer Begründung.

Die Engine verspricht keine Gewinne. Alle Ausgaben sind Wahrscheinlichkeits-
einschätzungen auf Basis historischer Muster.
"""

from __future__ import annotations

import json
import threading
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from ..analysis.market import MarketAnalysis
from ..strategies import Signal, Strategy, action_from_score, default_strategies

DISCLAIMER = ("Simulation/Paper-Trading. Keine Anlageberatung, keine Gewinnzusage. "
              "Vergangene Muster garantieren keine zukünftigen Ergebnisse.")


@dataclass
class StrategyEvaluation:
    strategy: str
    ic: float            # Information Coefficient (Spearman) auf Historie
    hit_rate: float      # Trefferquote der Richtung bei |score| >= 0.2
    n: int
    weight: float


@dataclass
class RiskAssessment:
    stop_loss: float
    take_profit: float
    stop_distance_pct: float
    reward_risk: float
    risk_score: float     # 0 (gering) .. 1 (hoch)
    notes: list[str] = field(default_factory=list)


@dataclass
class Decision:
    id: str
    timestamp: str
    symbol: str
    action: str           # BUY | SELL | HOLD
    ensemble_score: float
    confidence: float
    price: float
    signals: list[Signal]
    evaluations: list[StrategyEvaluation]
    risk: RiskAssessment
    reasons: list[str]
    analysis_summary: str
    llm_commentary: str | None = None
    disclaimer: str = DISCLAIMER

    def to_dict(self) -> dict:
        return asdict(self)


def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    if len(a) < 10:
        return 0.0
    ra = pd.Series(a).rank().to_numpy()
    rb = pd.Series(b).rank().to_numpy()
    if ra.std() == 0 or rb.std() == 0:
        return 0.0
    return float(np.corrcoef(ra, rb)[0, 1])


class AIEngine:
    def __init__(self, strategies: list[Strategy] | None = None, horizon: int = 6, eval_window: int = 400,
                 temperature: float = 0.1, weight_floor: float = 0.08, min_confidence: float = 0.55,
                 entry_threshold: float = 0.25, atr_stop_mult: float = 2.0, reward_risk: float = 2.0):
        self.strategies = strategies or default_strategies()
        self.horizon = horizon
        self.eval_window = eval_window
        self.temperature = temperature
        self.weight_floor = weight_floor
        self.min_confidence = min_confidence
        self.entry_threshold = entry_threshold
        self.atr_stop_mult = atr_stop_mult
        self.reward_risk = reward_risk

    # ---------- Strategievergleich ----------
    def evaluate_strategies(self, ind: pd.DataFrame, scores: dict[str, pd.Series]) -> list[StrategyEvaluation]:
        fwd = (ind["close"].shift(-self.horizon) / ind["close"] - 1).to_numpy()
        evals = []
        for name, s in scores.items():
            sv = s.to_numpy()[-self.eval_window:]
            fv = fwd[-self.eval_window:]
            m = ~np.isnan(sv) & ~np.isnan(fv)
            ic = _spearman(sv[m], fv[m]) if m.sum() >= 30 else 0.0
            active = m & (np.abs(np.nan_to_num(sv)) >= 0.2)
            hit = float(np.mean(np.sign(sv[active]) == np.sign(fv[active]))) if active.sum() >= 5 else 0.5
            evals.append(StrategyEvaluation(name, round(ic, 4), round(hit, 3), int(m.sum()), 0.0))
        ics = np.array([e.ic for e in evals])
        w = np.exp((ics - ics.max()) / self.temperature) if len(ics) else ics
        w = w / w.sum() if w.sum() > 0 else np.full(len(evals), 1 / max(1, len(evals)))
        w = np.maximum(w, self.weight_floor)
        # Strategien mit klar negativer Vorhersagekraft stark dämpfen
        w = np.where(ics < -0.05, self.weight_floor / 2, w)
        w = w / w.sum()
        for e, wi in zip(evals, w):
            e.weight = round(float(wi), 4)
        return evals

    # ---------- Risiko ----------
    def assess_risk(self, analysis: MarketAnalysis, direction: int) -> RiskAssessment:
        price, atr = analysis.price, max(analysis.atr, analysis.price * 0.001)
        dist = self.atr_stop_mult * atr
        if direction >= 0:
            sl, tp = price - dist, price + self.reward_risk * dist
        else:
            sl, tp = price + dist, price - self.reward_risk * dist
        notes = []
        risk = 0.3
        if analysis.volatility_regime == "high":
            risk += 0.25
            notes.append("Erhöhte Volatilität – größere Kursschwankungen möglich")
        elif analysis.volatility_regime == "low":
            risk -= 0.1
        if analysis.anomalies:
            risk += 0.2
            notes.append("Ungewöhnliche Marktbewegung erkannt")
        if direction != 0 and analysis.mtf_alignment * direction < 0:
            risk += 0.15
            notes.append("Signal läuft gegen den übergeordneten Trend")
        if analysis.rsi > 75 and direction > 0 or analysis.rsi < 25 and direction < 0:
            risk += 0.1
            notes.append("Einstieg in überdehnter Marktlage")
        return RiskAssessment(round(sl, 4), round(tp, 4), round(dist / price * 100, 3), self.reward_risk,
                              round(float(np.clip(risk, 0, 1)), 3), notes)

    # ---------- Entscheidung ----------
    def compute_scores(self, ind: pd.DataFrame) -> tuple[dict[str, pd.Series], dict[str, str]]:
        """Score-Serien aller Strategien; Fehler einzelner Strategien werden isoliert."""
        scores: dict[str, pd.Series] = {}
        errors: dict[str, str] = {}
        for strat in self.strategies:
            try:
                scores[strat.name] = strat.score_series(ind).clip(-1, 1)
            except Exception as exc:  # noqa: BLE001 - eine defekte Strategie darf nicht alles stoppen
                scores[strat.name] = pd.Series(np.nan, index=ind.index)
                errors[strat.name] = f"{type(exc).__name__}: {exc}"
        return scores, errors

    def decide(self, symbol: str, ind: pd.DataFrame, analysis: MarketAnalysis,
               scores: dict[str, pd.Series] | None = None, evals: list[StrategyEvaluation] | None = None,
               explain: bool = True) -> Decision:
        errors: dict[str, str] = {}
        if scores is None:
            scores, errors = self.compute_scores(ind)
        signals: list[Signal] = []
        row = ind.iloc[-1]
        for strat in self.strategies:
            s = scores[strat.name]
            last = float(s.iloc[-1]) if len(s) and not np.isnan(s.iloc[-1]) else 0.0
            if strat.name in errors:
                why = [f"Fehler: {errors[strat.name]}"]
            elif explain:
                try:
                    why = strat.explain(row, last)
                except Exception:  # noqa: BLE001
                    why = []
            else:
                why = []
            signals.append(Signal(strat.name, round(last, 4), action_from_score(last), why))
        if evals is None:
            evals = self.evaluate_strategies(ind, scores)
        weights = {e.strategy: e.weight for e in evals}
        ensemble = float(sum(weights[s.strategy] * s.score for s in signals))
        direction = int(np.sign(ensemble)) if abs(ensemble) >= self.entry_threshold else 0

        reasons: list[str] = []
        # Übereinstimmung der Strategien (gewichteter Anteil in Signalrichtung)
        agree = sum(weights[s.strategy] for s in signals if np.sign(s.score) == np.sign(ensemble) and abs(s.score) > 0.1)
        conf = 0.5 * min(1.0, abs(ensemble) / 0.6) + 0.5 * agree
        if direction and analysis.mtf_alignment * direction > 0.3:
            conf += 0.1
            reasons.append(f"Übergeordnete Zeitebenen bestätigen ({analysis.mtf_alignment:+.2f})")
        elif direction and analysis.mtf_alignment * direction < -0.3:
            conf -= 0.2
            reasons.append(f"Übergeordnete Zeitebenen widersprechen ({analysis.mtf_alignment:+.2f})")
        if analysis.volatility_regime == "high":
            conf -= 0.1
            reasons.append("Hohe Volatilität senkt die Konfidenz")
        if any(a.kind == "price_shock" for a in analysis.anomalies):
            conf -= 0.2
            reasons.append("Preisschock erkannt – Vorsicht")
        best = max(evals, key=lambda e: e.ic) if evals else None
        if best is not None and best.ic <= 0:
            conf -= 0.15
            reasons.append("Keine Strategie zeigte zuletzt positive Vorhersagekraft")
        conf = float(np.clip(conf, 0, 1))

        risk = self.assess_risk(analysis, direction)
        action = "HOLD"
        if direction > 0 and conf >= self.min_confidence:
            action = "BUY"
        elif direction < 0 and conf >= self.min_confidence:
            action = "SELL"
        if action == "HOLD":
            if direction == 0:
                reasons.insert(0, f"Ensemble-Score {ensemble:+.2f} unter Einstiegsschwelle ±{self.entry_threshold:.2f}")
            else:
                reasons.insert(0, f"Konfidenz {conf:.0%} unter Mindestwert {self.min_confidence:.0%}")
        else:
            reasons.insert(0, f"Ensemble-Score {ensemble:+.2f}, Konfidenz {conf:.0%}")
        top = sorted(signals, key=lambda s: abs(weights[s.strategy] * s.score), reverse=True)[:2]
        for s in top:
            reasons.append(f"{s.strategy} (Gewicht {weights[s.strategy]:.0%}): {s.action} {s.score:+.2f} – {s.reasons[0] if s.reasons else ''}")

        return Decision(
            id=uuid.uuid4().hex[:12], timestamp=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            symbol=symbol, action=action, ensemble_score=round(ensemble, 4), confidence=round(conf, 3),
            price=analysis.price, signals=signals, evaluations=evals, risk=risk, reasons=reasons,
            analysis_summary=analysis.summary,
        )


class DecisionJournal:
    """Append-only JSONL-Protokoll aller KI-Entscheidungen (Nachvollziehbarkeit)."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def write(self, decision: Decision) -> None:
        line = json.dumps(decision.to_dict(), ensure_ascii=False, default=str)
        with self._lock, self.path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")

    def tail(self, n: int = 50) -> list[dict]:
        if not self.path.exists():
            return []
        with self._lock:
            lines = self.path.read_text("utf-8").splitlines()[-n:]
        out = []
        for ln in reversed(lines):
            try:
                out.append(json.loads(ln))
            except json.JSONDecodeError:
                continue
        return out
