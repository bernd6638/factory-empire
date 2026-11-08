# Discord OS

**Discord OS** ist ein Verwaltungssystem für Discord-Server. Es besteht aus einem Discord-Bot, einem Web-Dashboard, einer PostgreSQL-Datenbank und Redis für Echtzeitkommunikation und Caching.

```
┌──────────────┐   WebSocket / REST   ┌──────────────────┐   Redis Pub/Sub (RPC, Events)   ┌──────────────┐
│  Dashboard   │ ◄──────────────────► │  API (Express)   │ ◄─────────────────────────────► │  Discord-Bot │
│ React + Vite │                      │  OAuth2, Session │                                 │  discord.js  │
└──────────────┘                      └────────┬─────────┘                                 └──────┬───────┘
                                               │            PostgreSQL (Prisma)                   │
                                               └──────────────────────┬───────────────────────────┘
                                                                      ▼
```

## Funktionen

| Bereich | Umfang |
|---|---|
| **Dashboard** | Mitglieder, Online-Zahl, Nachrichten pro Tag, neue Mitglieder, Moderationsaktionen, Serverwachstum, Aktivität nach Tag und Stunde, Bot-Status, Live-Aktivitätsfeed |
| **Serververwaltung** | Mehrere Server, Serverinfos, Kanäle und Kategorien, Rollen erstellen, bearbeiten und löschen, Kanalberechtigungen bearbeiten, Servereinstellungen |
| **Mitglieder** | Liste, Suche, Filter, Rollen zuweisen und entfernen, Profile mit 30-Tage-Statistik, Moderationshistorie, Economy-Konto, inaktive Mitglieder |
| **Moderation** | Warn, Timeout, Kick, Ban (auch temporär), Unban, Notizen, Fallakten, automatische Eskalation, geschützte Rollen, DM-Benachrichtigung |
| **Auto-Moderation** | Spam, Wiederholungen, Massen-Erwähnungen, Anti-Link mit Domain-Freigabe, Anti-Invite, Wortfilter (Platzhalter, Regex, Leetspeak), Großschreibung, Anti-Raid mit Sperre, Prüfung auf neue Konten |
| **Level & XP** | XP für Nachrichten und Voice, drei Levelkurven, Multiplikatoren pro Rolle und Kanal, Cooldown, Levelrollen, Coin-Belohnungen, Ranglisten (gesamt, Woche, Monat) |
| **Tickets** | Panel mit Buttons oder Auswahlmenü, Kategorien, private Ticket-Kanäle, Übernahme, Prioritäten, Antworten aus dem Dashboard, Transkripte (Datenbank, Discord, Download), Statistiken, Archivierung |
| **Economy** (virtuell) | Konten (Wallet und Bank), Daily mit Streak, Arbeit, Jobs, Firmen, Shop mit Rollen-Artikeln und Bestand, Inventar, Handel mit Annahme-Button, Überweisungen, Ranglisten, Transaktionshistorie |
| **Automatisierungen** | Regel-Editor mit 8 Auslösern (Beitritt, Austritt, Nachricht, Reaktion, Rolle, Level, Zeitplan per Cron, Inaktivität), Bedingungen, 8 Aktionen, Testlauf, Begrüßung, Auto-Rollen, `/remind` |
| **Voice-Manager** | Join-to-Create, Namensvorlage, Limits, Besitzer, `/voice`-Befehle, automatisches Löschen, Aufräumen nach Neustart |
| **Logging** | Nachrichten gelöscht und bearbeitet, Beitritte, Austritte, Rollen, Kanäle, Voice, Moderation, Server. Live im Dashboard, optional als Embed in Discord, CSV-Export, Aufbewahrungsdauer |
| **Plugins** | Jedes Modul einzeln aktivierbar, eigene Einstellungen, eigene Daten (Löschen pro Modul), isolierte Fehlerbehandlung mit Fehlerzähler |
| **Sicherheit** | Discord OAuth2, Redis-Sessions, verschlüsselte Tokens (AES-256-GCM), Rollenstufen (Betrachter, Moderator, Admin, Besitzer), CSRF-Schutz, Rate Limiting, Zod-Validierung, Audit-Log, Prüfung von Hierarchie und Bot-Rechten |

## Schnellstart (Windows)

1. Installiere [Node.js 22 LTS](https://nodejs.org) und [Docker Desktop](https://www.docker.com/products/docker-desktop/). Alternativ PostgreSQL und Redis direkt installieren.
2. Lege in Discord eine Anwendung an (siehe [docs/INSTALLATION.md](docs/INSTALLATION.md#1-discord-anwendung-erstellen)).
3. Doppelklick auf `scripts\windows\setup.bat`. Das Skript startet die Datenbanken, erzeugt die `.env`, installiert alles und baut die Anwendung.
4. Trage `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` und `DISCORD_CLIENT_SECRET` in die `.env` ein.
5. Doppelklick auf `scripts\windows\start.bat` und `http://localhost:3001` öffnen.

**Linux/macOS:** `docker compose up -d && npm run setup && npm start`

## Befehle

| Befehl | Zweck |
|---|---|
| `npm run setup` | Ersteinrichtung (.env, Schlüssel, Installation, Datenbank, Build) |
| `npm start` | Produktion: Migrationen anwenden, Bot und Dashboard starten |
| `npm run dev` | Entwicklung mit Hot-Reload (Dashboard unter :5173) |
| `npm run build` | Backend und Frontend bauen |
| `npm run start:bot` / `start:api` | Bot und API getrennt betreiben (Skalierung) |
| `npm test` | Unit-Tests · `INTEGRATION=1 npm test` inkl. Datenbank-, Redis- und API-Tests |
| `npm run db:migrate` | Neue Migration nach Schemaänderung erzeugen |
| `npm run db:studio` | Datenbank im Browser ansehen (Prisma Studio) |

## Dokumentation

- [Installation (Windows & Linux)](docs/INSTALLATION.md)
- [Architektur](docs/ARCHITEKTUR.md)
- [Module & Slash-Commands](docs/MODULE.md)
- [REST-API & WebSocket](docs/API.md)
- [Hosting auf einem Server](docs/DEPLOYMENT.md)
- [Eigene Module entwickeln](docs/PLUGIN-ENTWICKLUNG.md)

## Projektstruktur

```
discord-os/
├─ server/                 Backend (TypeScript)
│  ├─ prisma/              Datenbankschema + Migrationen
│  ├─ src/shared/          Konfiguration, Redis-Bus, Modul-Schemas, Hilfsfunktionen
│  ├─ src/bot/             Discord-Bot: Kern, Dienste, Module
│  ├─ src/api/             Express-API, OAuth2, WebSocket, Routen
│  └─ test/                Unit- und Integrationstests
├─ web/                    Dashboard (React, Tailwind, Framer Motion, Recharts)
├─ scripts/                Einrichtungs- und Startskripte (Windows/Linux)
├─ docs/                   Dokumentation
├─ docker-compose.yml      PostgreSQL + Redis (+ optional die Anwendung)
└─ .env.example            Beispielkonfiguration
```

Die Economy ist ausschließlich ein virtuelles Spielsystem ohne echtes Geld.
