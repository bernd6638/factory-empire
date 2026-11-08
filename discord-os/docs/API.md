# REST-API & WebSocket

Alle Endpunkte liegen unter `/api` und liefern JSON. Für die Authentifizierung dient das Session-Cookie `dos.sid`.

Ändernde Anfragen (POST, PUT, PATCH, DELETE) brauchen den Header `X-Requested-With: DiscordOS`. Kommt die Anfrage von einem anderen Origin, wird sie abgelehnt.

Fehler werden so gemeldet: `{ "error": "Meldung", "code": "CODE", "details"?: … }`, mit den Statuscodes 400 (Validierung), 401, 403, 404, 409, 429, 503 (Bot offline) und 504 (Bot-Timeout).

Zugriffsstufen: **V** = Betrachter, **M** = Moderator, **A** = Admin, **O** = Besitzer.

## Authentifizierung & Meta

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/auth/login?returnTo=/pfad` | Weiterleitung zu Discord OAuth2 |
| GET | `/auth/callback` | OAuth2-Rückkehr (von Discord aufgerufen) |
| POST | `/auth/logout` | Abmelden, Token wird bei Discord widerrufen |
| GET | `/auth/me` | Angemeldeter Nutzer |
| GET | `/meta` | Version, Einladungslink, Bot-Status |
| GET | `/meta/health` | Health-Check (Datenbank, Bot) |

## Server

| Methode | Pfad | Stufe | Beschreibung |
|---|---|---|---|
| GET | `/guilds` | – | Verwaltbare Server des Nutzers (`?refresh=1` lädt neu von Discord) |
| GET | `/guilds/:id` | V | Details, Zugriffsstufe, Modulstatus, Live-Daten |
| GET | `/guilds/:id/overview?days=30` | V | Dashboard-Kennzahlen und Zeitreihen |
| GET | `/guilds/:id/server/channels` · `/roles` · `/commands` | V | Kanäle, Rollen, Slash-Commands |
| POST · PATCH · DELETE | `/guilds/:id/server/roles[/:roleId]` | A | Rollen verwalten |
| PUT · DELETE | `/guilds/:id/server/channels/:cid/permissions/:targetId` | A | Kanalberechtigungen |
| PATCH | `/guilds/:id/server/settings` | A | Servereinstellungen |

## Mitglieder

| Methode | Pfad | Stufe | Beschreibung |
|---|---|---|---|
| GET | `/guilds/:id/members?query&roleId&bots&offset&limit` | V | Liste |
| GET | `/guilds/:id/members/inactive?days=30` | V | Inaktive Mitglieder |
| GET | `/guilds/:id/members/:userId` | V | Profil mit Statistik, Fällen, Economy |
| PUT | `/guilds/:id/members/:userId/roles` | M | `{ add: [], remove: [] }` |
| POST | `/guilds/:id/members/:userId/xp` | A | `{ xp }` oder `{ level }` |

## Moderation

| Methode | Pfad | Stufe | Beschreibung |
|---|---|---|---|
| GET | `/guilds/:id/moderation/cases?type&source&userId&q&page` | M | Fälle |
| GET | `/guilds/:id/moderation/stats` | M | Statistik (30 Tage) |
| POST | `/guilds/:id/moderation/actions` | M | `{ type, userId, reason?, durationMinutes?, deleteMessageSeconds? }` |
| POST | `/guilds/:id/moderation/cases/:nr/revoke` | M | Fall aufheben |
| PATCH | `/guilds/:id/moderation/cases/:nr` | M | Grund ändern |
| GET | `/guilds/:id/moderation/bans` | M | Bannliste |
| GET · POST | `/guilds/:id/moderation/raid` · `/raid/end` | M | Raid-Sperre anzeigen oder beenden |

## Level, Tickets, Economy, Automatisierungen, Voice, Logs

| Methode | Pfad | Stufe |
|---|---|---|
| GET | `/guilds/:id/leveling/leaderboard?period=all\|week\|month` | V |
| POST | `/guilds/:id/leveling/curve-preview` | V |
| POST | `/guilds/:id/leveling/sync-roles` · `/reset` | A |
| GET | `/guilds/:id/tickets?status&priority&q&page` · `/stats` · `/:tid` · `/:tid/transcript.txt` | M |
| POST | `/guilds/:id/tickets/:tid/close` · `/assign` · `/priority` · `/reply` | M |
| POST | `/guilds/:id/tickets/panel` · DELETE `/:tid` | A |
| GET | `/guilds/:id/economy/overview` · `/accounts` · `/transactions` · `/shop` · `/jobs` · `/companies` · `/trades` | V |
| PATCH | `/guilds/:id/economy/accounts/:userId` (`walletDelta`, `bankDelta`) | A |
| POST · PATCH · DELETE | `/guilds/:id/economy/shop[/:itemId]` · `/jobs[/:jobId]` · DELETE `/companies/:cid` | A |
| GET | `/guilds/:id/automations` · `/meta` · `/reminders` | V |
| POST · PUT · DELETE | `/guilds/:id/automations[/:rid]` · POST `/:rid/toggle` · `/:rid/test` | A |
| GET | `/guilds/:id/voice` | V |
| DELETE | `/guilds/:id/voice/channels/:cid` | M |
| GET | `/guilds/:id/logs?category&type&userId&channelId&q&from&to&before&limit` · `/stats` | M |
| GET | `/guilds/:id/logs/export.csv` | A |

## Module & Einstellungen

| Methode | Pfad | Stufe | Beschreibung |
|---|---|---|---|
| GET | `/guilds/:id/modules` | V | Alle Module mit Status, Fehlern und Datenmenge |
| GET | `/guilds/:id/modules/:key` | V | Einstellungen und Standardwerte |
| PUT | `/guilds/:id/modules/:key` | A | `{ enabled?, config? }` (vollständige Konfiguration, validiert) |
| POST | `/guilds/:id/modules/:key/reset` | A | Einstellungen auf Standard |
| POST | `/guilds/:id/modules/:key/data/reset` | O | `{ confirm: "<key>" }`, löscht die Moduldaten |
| POST | `/guilds/:id/modules/welcome/test` | A | Begrüßung testen |
| GET · POST · DELETE | `/guilds/:id/settings/permissions[/:pid]` | A | Dashboard-Berechtigungen (Admin-Stufe nur durch Besitzer) |
| GET | `/guilds/:id/settings/audit?page` | A | Audit-Log |

## WebSocket `/ws`

Die Verbindung wird über das Session-Cookie authentifiziert.

```jsonc
// Client → Server
{ "type": "subscribe", "guildId": "123…" }
{ "type": "unsubscribe" }

// Server → Client
{ "type": "subscribed", "guildId": "123…", "ts": 1700000000000 }
{ "type": "<ereignis>", "guildId": "123…" | null, "data": { … }, "ts": 1700000000000 }
```

| Ereignis | Daten |
|---|---|
| `bot.status` (global) | Ping, Server, Uptime, Speicher, `online` |
| `stats.tick` | Neue Nachrichten, Beitritte, Austritte, Moderationsaktionen seit dem letzten Intervall |
| `stats.snapshot` | Mitgliederzahl, Online-Zahl |
| `member.join` · `member.leave` | Mitglied, aktuelle Mitgliederzahl |
| `log`* | Neuer Logeintrag |
| `mod.case`* · `automod`* · `raid`* | Moderationsereignisse |
| `ticket.created`* · `ticket.updated`* · `ticket.message`* | Ticketaktivität |
| `level.up` · `automation.run` · `economy.purchase` · `economy.trade` | Sonstige Aktivität |
| `voice.created` · `voice.deleted` · `voice.state` | Voice |
| `config.updated` | Einstellungen wurden geändert (andere Dashboards laden neu) |

\* Nur für Nutzer ab Stufe Moderator.
