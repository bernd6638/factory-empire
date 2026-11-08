# Architektur

## Überblick

Discord OS besteht aus drei Laufzeitkomponenten und zwei Datenspeichern:

| Komponente | Technik | Aufgabe |
|---|---|---|
| **Bot** (`server/src/bot`) | discord.js 14 | Gateway-Verbindung, Slash-Commands, Buttons und Modals, Moderation, Ereignisverarbeitung, Hintergrundjobs |
| **API** (`server/src/api`) | Express 5, ws | OAuth2-Login, Sessions, REST-Endpunkte, WebSocket-Live-Updates, Auslieferung des Dashboards |
| **Dashboard** (`web`) | React 19, Vite, Tailwind 4, Framer Motion, Recharts, TanStack Query | Benutzeroberfläche |
| **PostgreSQL** | Prisma ORM | Dauerhafte Daten (Einstellungen, Statistiken, Fälle, Tickets, Economy …) |
| **Redis** | ioredis | Pub/Sub zwischen Bot und API, Sessions, Rate Limiting, Caches, Bot-Status |

Bot und API laufen standardmäßig in **einem** Prozess (`node dist/index.js`). Sie kommunizieren trotzdem ausschließlich über Redis. Deshalb lassen sie sich ohne Codeänderung trennen (`start:bot` / `start:api`) und die API lässt sich horizontal skalieren.

## Kommunikation (Redis-Bus)

`server/src/shared/bus.ts`

| Kanal | Richtung | Inhalt |
|---|---|---|
| `dos:events` | Bot → API → WebSocket | Live-Ereignisse: `log`, `mod.case`, `member.join`, `stats.tick`, `ticket.*`, `voice.*`, `bot.status` … |
| `dos:rpc:req` / `dos:rpc:res` | API → Bot | RPC-Aufrufe mit Korrelations-ID und Timeout, z. B. `mod.action`, `guild.roles`, `tickets.close` |
| `dos:config` | API → Bot | Cache-Invalidierung nach Einstellungsänderungen (sofort wirksam) |
| `dos:bot:status` (Key) | Bot | Heartbeat alle 15 s mit TTL 45 s. Fehlt der Key, meldet die API „Bot offline“ |

Discord-Live-Daten wie Rollen, Kanäle und Mitglieder sowie alle Aktionen in Discord laufen über RPC. Dadurch nutzt das Dashboard den Cache des Bots und prüft dessen Berechtigungen. Für die API wird kein zweiter Bot-Login benötigt. Gespeicherte Daten wie Statistiken, Logs und Fälle liest die API direkt aus PostgreSQL.

## Plugin-System

- **Definition** (`shared/modules.ts`): Jedes Modul hat Metadaten und ein Zod-Schema mit Standardwerten. Die Einstellungen liegen pro Server in `GuildModule.config` (JSON) und werden beim Laden immer validiert. Neue Felder bekommen dabei automatisch ihre Standardwerte, ungültige Felder fallen auf Standardwerte zurück.
- **Bot-Seite** (`bot/core/ModuleManager.ts`): Ein Modul liefert `commands`, `components` (Buttons, Menüs, Modals per `customId`-Präfix), `events`, `jobs` (Intervalle), `rpc` (Methoden für das Dashboard) und `onReady`.
  - Events werden nur an Module verteilt, die auf dem jeweiligen Server aktiv sind.
  - Jeder Handler läuft in einem eigenen `try/catch`. Fehler werden protokolliert und pro Modul in Redis gezählt (`dos:module:errors`). Andere Module laufen weiter.
  - Jobs laufen nie überlappend.
- **Konfiguration im Bot** (`bot/core/ConfigService.ts`): In-Memory-Cache mit TTL und gebündelten Ladevorgängen. Über `dos:config` wird der Cache sofort invalidiert.
- **Eigene Daten:** Module haben eigene Tabellen (z. B. `Ticket`, `EconomyAccount`) oder nutzen den Schlüssel-Wert-Speicher `ModuleData`. Im Dashboard unter *Plugins* lassen sich die Daten eines Moduls zählen und löschen.

## Statistik und Performance

- **StatsService** (`bot/core/StatsService.ts`): Nachrichten-, XP-, Voice-, Beitritts- und Moderationszähler werden im Speicher gesammelt und alle 15 s per Bulk-Upsert (`INSERT … SELECT FROM UNNEST … ON CONFLICT`) geschrieben. Bei hoher Aktivität bleibt das ein Datenbankzugriff pro Tabelle und Intervall.
- **Tabellen:** `GuildStatHour` (stündlich), `GuildStatDay` (Mitgliederzahl, Online-Spitze), `MemberDailyStat` (Wochen- und Monatsranglisten, Profile).
- **Online-Zahl:** Mit Presence-Intent aus dem Cache, sonst alle 10 min über `approximate_presence_count`.
- **Ticket-Kanäle** werden im Speicher indiziert. So braucht nicht jede Nachricht eine Datenbankabfrage.
- **Discord-Limits:** discord.js übernimmt REST-Ratenlimits und Warteschlangen. Mitgliederlisten werden beim Start nacheinander mit Pause geladen (nur für Server bis 50.000 Mitglieder). Der Nachrichten-Cache ist pro Kanal begrenzt und wird regelmäßig geleert.
- **Aufbewahrung:** Logs nach `retentionDays` (Standard 90), Stundenstatistik nach 365 Tagen.

## Sicherheit

| Maßnahme | Umsetzung |
|---|---|
| Anmeldung | Discord OAuth2 (Scopes `identify guilds`), `state`-Prüfung, Session-Regeneration nach dem Login |
| Sessions | `express-session` mit Redis-Speicher, Cookie `httpOnly`, `SameSite=Lax`, `secure` bei HTTPS, 7 Tage rollierend |
| Tokens | OAuth-Tokens AES-256-GCM-verschlüsselt (`ENCRYPTION_KEY`) in der Session, nie im Frontend. Bot-Token nur serverseitig |
| Berechtigungen | Stufen VIEWER < MODERATOR < ADMIN < OWNER. Besitzer und Bot-Owner → OWNER, „Server verwalten“ → ADMIN, zusätzliche Freigaben für Rollen oder Nutzer über `DashboardPermission`. Jede Route prüft die Mindeststufe (`guildAccess`) |
| CSRF | Ändernde Anfragen brauchen den Header `X-Requested-With: DiscordOS` und den eigenen `Origin`. Dazu kommt das SameSite-Cookie |
| Eingaben | Jede Eingabe wird mit Zod validiert (API und RPC im Bot) |
| Rate Limiting | `express-rate-limit` mit Redis-Speicher: 300 Anfragen/min allgemein, 30/min für Login |
| Datenbank | Prisma (parametrisiert). Raw-SQL nur mit Tagged Templates bzw. Parametern, Sortierspalten aus einer Whitelist |
| Header | Helmet inkl. Content-Security-Policy |
| Audit | Jede erfolgreiche ändernde Dashboard-Anfrage landet in `AuditLog` (Nutzer, Aktion, Parameter, IP). Felder mit sensiblen Namen werden entfernt |
| Bot-Rechte | Vor jeder Aktion prüft der Bot seine Discord-Berechtigungen und die Rollenhierarchie. Er vergibt keine Rechte, die er selbst nicht besitzt |
| WebSocket | Authentifizierung über das Session-Cookie, Origin-Prüfung, Zugriff auf genau einen abonnierten Server. Moderationsereignisse erhalten nur Moderatoren |

## Ausfallsicherheit

- Bot-Login wird bei Netzwerkfehlern mit Backoff wiederholt. discord.js verbindet das Gateway selbst neu.
- Nach einem Neustart werden Server synchronisiert, Temp-Voice-Kanäle aufgeräumt, offene Tickets neu indiziert und abgelaufene temporäre Banns aufgehoben. Zeitpläne und Erinnerungen laufen über die Datenbank weiter.
- Eindeutige Datenbank-Constraints verhindern doppelte Fall- und Ticketnummern. Kollidiert eine gleichzeitige Anlage, wird sie mit der nächsten Nummer wiederholt.
- `start.bat` startet nach einem Absturz neu, Docker nutzt `restart: unless-stopped`.
