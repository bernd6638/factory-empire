# Installation

Diese Anleitung führt Schritt für Schritt durch die Einrichtung auf einem Windows-PC. Hinweise für Linux und macOS stehen jeweils dabei.

## Voraussetzungen

| Software | Version | Hinweis |
|---|---|---|
| Node.js | 20.11 oder neuer (empfohlen 22 LTS) | https://nodejs.org (bei der Installation „Add to PATH“ aktiviert lassen) |
| PostgreSQL | 14 oder neuer | Am einfachsten über Docker Desktop, alternativ der Windows-Installer von postgresql.org |
| Redis | 6 oder neuer | Über Docker Desktop. Ohne Docker unter Windows: [Memurai](https://www.memurai.com/) (Redis-kompatibel) |

> **Empfehlung:** Installiere [Docker Desktop](https://www.docker.com/products/docker-desktop/). Dann startet `docker compose up -d` PostgreSQL und Redis mit den passenden Zugangsdaten aus der `.env.example`.

## 1. Discord-Anwendung erstellen

1. Öffne https://discord.com/developers/applications und klicke auf **New Application**.
2. **General Information:** Notiere die **Application ID**. Sie ist deine `DISCORD_CLIENT_ID`.
3. **OAuth2:**
   - Klicke unter *Client Secret* auf **Reset Secret** und notiere den Wert. Das ist dein `DISCORD_CLIENT_SECRET`.
   - Füge unter **Redirects** hinzu: `http://localhost:3001/api/auth/callback`.
     Für die Entwicklung zusätzlich `http://localhost:5173/api/auth/callback`, auf dem Server `https://deine-domain.de/api/auth/callback`.
4. **Bot:**
   - Klicke auf **Reset Token** und notiere den Token. Das ist dein `DISCORD_TOKEN`. Teile ihn niemals.
   - Aktiviere unter **Privileged Gateway Intents**:
     - ✅ **Server Members Intent**: Mitgliederliste, Beitritte, Rollen, Auto-Rollen
     - ✅ **Message Content Intent**: Auto-Moderation, Logging, Automatisierungen
     - ☐ **Presence Intent** (optional): genaue Online-Zahlen. Dann `ENABLE_PRESENCE_INTENT=true` setzen. Ohne diesen Intent schätzt Discord OS die Online-Zahl über die Discord-API.
5. Den Bot lädst du später direkt aus dem Dashboard ein (Serverauswahl → **Einladen**). Der Link enthält alle benötigten Berechtigungen.

## 2. Discord OS einrichten

### Windows

1. Entpacke bzw. klone das Projekt, z. B. nach `C:\DiscordOS`.
2. Doppelklicke auf `scripts\windows\setup.bat`. Das Skript
   - startet PostgreSQL und Redis über Docker (falls installiert),
   - erstellt die `.env` und erzeugt `SESSION_SECRET` und `ENCRYPTION_KEY`,
   - installiert alle Abhängigkeiten,
   - legt die Datenbanktabellen an,
   - baut Backend und Dashboard.
3. Öffne die `.env` mit einem Editor und trage `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` und `DISCORD_CLIENT_SECRET` ein.
4. Optional: Trage deine Discord-User-ID bei `BOT_OWNER_IDS` ein. Damit hast du auf allen Servern des Bots vollen Zugriff.

### Linux / macOS

```bash
docker compose up -d        # PostgreSQL + Redis
npm run setup               # .env, Schlüssel, Installation, Migrationen, Build
nano .env                   # Discord-Zugangsdaten eintragen
```

### Ohne Docker

Lege eine Datenbank und einen Benutzer an und passe `DATABASE_URL` und `REDIS_URL` in der `.env` an:

```sql
CREATE USER discordos WITH PASSWORD 'ein-sicheres-passwort';
CREATE DATABASE discordos OWNER discordos;
```

## 3. Starten

| System | Befehl |
|---|---|
| Windows | Doppelklick auf `scripts\windows\start.bat` (startet nach einem Absturz automatisch neu) |
| Linux/macOS | `npm start` oder `scripts/linux/start.sh` |

Öffne anschließend **http://localhost:3001**, melde dich mit Discord an und wähle einen Server. Hat der Bot den Server noch nicht betreten, klicke auf **Einladen**.

Beim Start passiert automatisch Folgendes:

- Ausstehende Datenbank-Migrationen werden angewendet (`prisma migrate deploy`).
- Der Bot synchronisiert alle Server und lädt die Mitgliederlisten.
- Fehlende Moduleinstellungen werden mit Standardwerten angelegt.
- Slash-Commands werden registriert. Global kann das bis zu einer Stunde dauern. Mit `DEV_GUILD_ID` werden sie sofort auf einem Testserver registriert.

## 4. Entwicklungsmodus

```bash
npm run dev     # Windows: scripts\windows\dev.bat
```

- Backend mit Hot-Reload auf Port 3001, Dashboard über Vite auf **http://localhost:5173**.
- Setze dafür `PUBLIC_URL=http://localhost:5173` in der `.env` und trage die passende Redirect-URL bei Discord ein.

## Häufige Probleme

| Problem | Lösung |
|---|---|
| `Ungültige Konfiguration (.env)` | Die Meldung nennt das fehlerhafte Feld. Vergleiche mit `.env.example`. |
| `Privilegierte Intents sind nicht aktiviert` | Developer-Portal → Bot → Server Members und Message Content aktivieren. |
| Login leitet zurück zu „Discord hat die Anmeldung abgelehnt“ | Redirect-URL bei Discord muss exakt `<PUBLIC_URL>/api/auth/callback` sein. Prüfe Client-ID und Secret. |
| Dashboard zeigt „Bot offline“ | Läuft der Prozess? Ist Redis erreichbar? API und Bot müssen dieselbe `REDIS_URL` verwenden. |
| `Datenbank nicht erreichbar` | Läuft PostgreSQL (`docker compose ps`)? Stimmt `DATABASE_URL`? |
| Slash-Commands erscheinen nicht | Globale Registrierung dauert bis zu einer Stunde. Zum Testen `DEV_GUILD_ID` setzen. Den Bot mit dem Scope `applications.commands` einladen (der Dashboard-Link enthält ihn). |
| Aktion schlägt mit „Hierarchie“ fehl | Die höchste Rolle des Bots muss in den Servereinstellungen über den zu verwaltenden Rollen und Mitgliedern stehen. |
