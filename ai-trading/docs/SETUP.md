# Einrichtung, Integrationen und Zugangsdaten

## 1. Technologie-Analyse

| Komponente | Wahl | Begründung |
|---|---|---|
| Sprache | Python ≥ 3.10 (getestet mit 3.13) | Standard im Quant-Umfeld, pandas/numpy |
| Datenverarbeitung | pandas, numpy | vektorisierte Indikatoren ohne Look-Ahead |
| Persistenz | SQLite (Standardbibliothek) | keine Serverinstallation, transaktionssicher, WAL-Modus |
| API / Dashboard | FastAPI + Uvicorn, statisches HTML | leichtgewichtig, keine Build-Kette |
| Charts | TradingView Lightweight Charts 4.2.3 (Apache-2.0) | lokal mitgeliefert unter `trading_system/dashboard/vendor/`, funktioniert offline |
| Verschlüsselung | `cryptography` (Fernet + PBKDF2-HMAC-SHA256, 600 000 Iterationen) | sichere Ablage von API-Schlüsseln |
| ML | eigene logistische Regression in numpy | keine schwere Abhängigkeit, voll nachvollziehbar |
| LLM (optional) | Anthropic Python SDK, Modell `claude-opus-5-5` | natürlichsprachige Marktkommentare |

## 2. Übersicht der Integrationen

### Im Projekt installiert und konfiguriert

| Integration | Status | Benötigt |
|---|---|---|
| Python-Abhängigkeiten (`requirements.txt`) | installiert und getestet | – |
| Offline-Marktsimulator | aktiv, keine Zugangsdaten nötig | – |
| Yahoo-Chart-Endpunkt (verzögert) | eingebaut, ohne Schlüssel | Netzwerkzugriff auf `query1.finance.yahoo.com` |
| Alpaca Market Data API v2 | eingebaut, nur Lesezugriff auf `data.alpaca.markets` | `ALPACA_API_KEY`, `ALPACA_API_SECRET` |
| Alpha Vantage | eingebaut | `ALPHAVANTAGE_API_KEY` |
| Claude API (KI-Kommentar) | eingebaut, standardmäßig aus | `ANTHROPIC_API_KEY` + `TS_LLM_ENABLED=true` |
| GitHub Actions CI | `.github/workflows/ai-trading-tests.yml` | – |

Die Anbieterkette im Modus `auto` lautet: **Alpaca → Alpha Vantage → Yahoo → Simulator**. Ein
Anbieter wird nur eingereiht, wenn seine Zugangsdaten vorhanden sind. Fällt einer aus, pausiert der
Circuit-Breaker ihn für 5 Minuten. Welcher Anbieter gerade liefert, zeigen Dashboard und
`/api/status`.

### Gefundene MCP-Server / Claude-Plugins (nicht automatisch verbunden)

Im Connector-Verzeichnis gefunden. Sie erfordern eine Anmeldung mit deinem eigenen Konto und
wurden deshalb **nicht** eigenständig verbunden:

| Name | Zweck | Hinweis |
|---|---|---|
| Alpha Vantage MCP Server | Kurse, Fundamentaldaten, Indikatoren, News für Claude | Konto + API-Schlüssel nötig; in claude.ai unter Einstellungen → Connectors verbinden |
| Financial Datasets (MCP) | Fundamentaldaten, Filings | Konto nötig |
| TradingCalc (Plugin) | deterministische Rechenhilfen (Positionsgröße, VaR, Sharpe) | optional, für interaktive Analysen in Claude |

Diese Connectoren helfen bei interaktiven Analysen mit Claude. Das Trading-System selbst greift über
die oben genannten HTTP-Schnittstellen direkt auf die Daten zu und braucht sie nicht.

### Einschränkung der Entwicklungsumgebung

In der Cloud-Umgebung, in der das System gebaut wurde, sind externe Finanzdaten-Hosts (u. a.
Yahoo) durch die Netzwerkrichtlinie gesperrt. Alle Tests mit echten Anbietern laufen daher gegen
gemockte HTTP-Antworten. Live-Abrufe wurden dort **nicht** ausgeführt. Auf deinem Rechner gibt es
diese Sperre nicht.

## 3. Fehlende Zugangsdaten

Es wurden **keine** Zugangsdaten erfunden oder hinterlegt. Für echte Marktdaten fehlen:

| Variable | Woher | Kosten |
|---|---|---|
| `ALPACA_API_KEY` / `ALPACA_API_SECRET` | <https://alpaca.markets> → Konto anlegen → **Paper Trading** Dashboard → „API Keys“ | Basic-Datenfeed (IEX) kostenlos |
| `ALPHAVANTAGE_API_KEY` | <https://www.alphavantage.co/support/#api-key> | kostenloser Plan mit engen Rate-Limits |
| `ANTHROPIC_API_KEY` (optional) | <https://console.anthropic.com> → API Keys | nutzungsabhängig; Kommentare werden 5 Min. je Symbol gecacht |

> Für Alpaca genügen Schlüssel des **Paper**-Kontos. Das System nutzt sie ausschließlich für den
> Marktdaten-Host `data.alpaca.markets` und ruft nie Order-Endpunkte auf. Ein Test
> (`test_no_live_order_code_paths`) stellt sicher, dass kein solcher Code hinzukommt.

## 4. Manuelle Schritte

1. Python ≥ 3.10 installieren, dann im Ordner `ai-trading`:

   ```bash
   pip install -r requirements.txt
   ```

2. Zugangsdaten hinterlegen – **eine** der beiden Varianten:

   - **Verschlüsselter Tresor (empfohlen):**

     ```bash
     python -m trading_system vault set ALPACA_API_KEY
     ```

     ```bash
     python -m trading_system vault set ALPACA_API_SECRET
     ```

     Beim Start dann `TS_VAULT_PASSWORD` setzen (z. B. in der Shell-Sitzung, nicht in Dateien im Repository).

   - **`.env`-Datei:** `.env.example` nach `.env` kopieren und ausfüllen (`.env` ist in `.gitignore`).

3. Optional `config.example.json` nach `config.json` kopieren und Symbole, Kapital und Risiko anpassen.
4. Prüfen:

   ```bash
   python -m trading_system status
   ```

5. Starten:

   ```bash
   python -m trading_system serve --autostart
   ```

## 5. Sicherheit

- Einzige Betriebsart: `paper`. `TS_TRADING_MODE=live` oder `TS_LIVE_TRADING=true` → Abbruch.
- Hebel (`max_gross_exposure > 1`) und Risiko > 5 % pro Trade werden abgelehnt.
- Schlüssel werden nie geloggt; Dashboard/API zeigen nur „gesetzt/fehlt“.
- Die API lauscht standardmäßig nur auf `127.0.0.1` und hat **keine Authentifizierung**. Nicht
  ungeschützt ins Internet stellen.
