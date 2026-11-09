# KI-Sprach-Bot (lokal)

Der Bot tritt einem Sprachkanal bei, hört zu und unterhält sich per Stimme. Alles läuft auf deinem eigenen PC. Es fallen keine Kosten an, und es werden keine Daten an fremde Dienste geschickt.

| Baustein | Programm | Läuft auf |
|---|---|---|
| Sprache → Text | Whisper (`faster-whisper`, Modell `small`) | CPU |
| Gespräch | Ollama mit z. B. `qwen2.5:7b` | NVIDIA-Grafikkarte |
| Text → Sprache | Piper (deutsche Stimme „Thorsten“) | CPU |

## Voraussetzungen (Windows)

- NVIDIA-Grafikkarte mit mindestens 6 GB Grafikspeicher. Bei 8 GB passt `qwen2.5:7b` (z. B. RTX 3050 8 GB, RTX 3060).
- Aktueller **NVIDIA-Treiber** (GeForce Experience bzw. nvidia.com).
- **Docker Desktop** mit WSL 2. Die Grafikkarte wird darüber automatisch durchgereicht.
- 16 GB Arbeitsspeicher und etwa 10 GB freier Speicherplatz für die Modelle.

GPU-Test (optional):

```powershell
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

## Starten

```powershell
docker compose --profile app --profile voice up -d --build
```

Dabei werden zusätzlich zwei Dienste gestartet: `voice-ai` (Whisper + Piper) und `ollama`. Beim ersten Start lädt `voice-ai` das Whisper-Modell und die Stimme (zusammen etwa 600 MB).

## Einrichten im Dashboard

1. **KI-Sprach-Bot → Einstellungen:** Modul aktivieren, Namen festlegen (Standard „Rad“), Modell und Stimme wählen, speichern.
2. **KI-Sprach-Bot → Live:** Die Checkliste zeigt, ob Sprachdienst, Ollama und Modell bereit sind. Über **„Modell herunterladen“** lädst du das Sprachmodell einmalig (etwa 2–5 GB) mit Fortschrittsanzeige.
3. Über **„Testen“** kannst du ohne Sprachkanal prüfen, ob das Modell antwortet.
4. Bot in einen Sprachkanal holen: im Dashboard unter **„Beitreten“** oder in Discord mit `/talk join`.

## Benutzung

- Sprich den Bot mit seinem Namen an: „**Rad**, erzähl mir einen Witz.“ oder „**Hey Rad**, wie war dein Tag?“
- Nach einer Antwort kannst du 20 Sekunden lang ohne Namen weiterreden (einstellbar).
- `/talk leave` lässt den Bot gehen, `/talk reset` löscht den Gesprächsverlauf.
- Ist niemand mehr im Kanal, geht der Bot nach 5 Minuten automatisch (einstellbar).

## Datenschutz

- Audio wird nur im Arbeitsspeicher verarbeitet und **nicht gespeichert**.
- Beim Beitreten schreibt der Bot einen Hinweis in den Kanal, dass er zuhört.
- Optional schränkst du ein, welche Rollen mit dem Bot sprechen dürfen.
- Eine Mitschrift in einem Textkanal gibt es nur, wenn du einen Kanal dafür festlegst.

## Leistung

- Typische Antwortzeit mit RTX 3050 und `qwen2.5:7b`: etwa 3–6 Sekunden, je nach Antwortlänge.
- Schneller geht es mit `qwen2.5:3b` oder einer kürzeren maximalen Antwortlänge.
- Für eine genauere Spracherkennung `WHISPER_MODEL=medium` in der `.env` setzen. Das ist langsamer.

## Fehlerbehebung

| Problem | Lösung |
|---|---|
| Checkliste: „Ollama nicht erreichbar“ | Läuft der Container? `docker compose ps`. Funktioniert der GPU-Test oben? |
| „Sprachdienst nicht erreichbar“ | `docker compose logs voice-ai`. Beim ersten Start werden die Modelle geladen, kurz warten. |
| Bot reagiert nicht | Wurde der Name richtig erkannt? In der Live-Mitschrift steht, was er verstanden hat. Ggf. weitere Aktivierungswörter hinzufügen. |
| Antworten sehr langsam | Kleineres Modell wählen. Prüfen, ob Ollama die GPU nutzt (`docker compose logs ollama` sollte die Grafikkarte nennen). |
| Bot kann nicht beitreten | Er braucht im Kanal die Rechte „Verbinden“ und „Sprechen“. |
