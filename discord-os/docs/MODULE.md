# Module & Slash-Commands

Alle Module lassen sich im Dashboard unter **Plugins** einzeln aktivieren. Bei einem deaktivierten Modul antworten seine Befehle mit einem Hinweis, seine automatischen Aktionen ruhen.

## Kern (immer aktiv)

- Synchronisiert Server, Mitgliederprofile, Beitritte und Austritte.
- Sammelt die Statistik (Nachrichten, Voice-Minuten, Online-Zahl).
- Sendet alle 15 s den Bot-Status (Heartbeat) und liefert dem Dashboard die Daten zu Rollen, Kanälen und Mitgliedern.

| Befehl | Beschreibung |
|---|---|
| `/serverinfo` | Informationen über den Server |
| `/dashboard` | Link zum Dashboard |

## Moderation

| Befehl | Berechtigung | Beschreibung |
|---|---|---|
| `/warn mitglied [grund]` | Timeout vergeben | Verwarnung, löst ggf. Eskalation aus |
| `/timeout mitglied dauer [grund]` | Timeout vergeben | z. B. `10m`, `2h`, `1d` (max. 28 Tage) |
| `/untimeout mitglied [grund]` | Timeout vergeben | Timeout aufheben |
| `/kick mitglied [grund]` | Mitglieder kicken | |
| `/ban mitglied [dauer] [nachrichten_loeschen] [grund]` | Mitglieder bannen | Mit `dauer` temporärer Bann, wird automatisch aufgehoben |
| `/unban user_id [grund]` | Mitglieder bannen | |
| `/note mitglied grund` | Timeout vergeben | Interne Notiz (Fallakte) |
| `/warnings mitglied` | Timeout vergeben | Moderationshistorie |
| `/case nummer` | Timeout vergeben | Fall anzeigen |
| `/purge anzahl [mitglied]` | Nachrichten verwalten | Bis zu 100 Nachrichten löschen (jünger als 14 Tage) |

**Einstellungen:** DM an Betroffene, Begründungspflicht, Protokollkanal, geschützte Rollen, Verfall von Verwarnungen, Eskalationsstufen (z. B. 3 Verwarnungen → 1 h Timeout, 5 → Kick).

Jede Aktion prüft die Bot-Rechte, die Rollenhierarchie von Bot und Moderator sowie geschützte Rollen. Daraus entsteht ein Fall mit fortlaufender Nummer.

## Auto-Moderation

| Regel | Erkennung |
|---|---|
| Spam | X Nachrichten in Y Sekunden, N-mal dieselbe Nachricht, zu viele Erwähnungen |
| Anti-Invite | Fremde Discord-Einladungen (eigene optional erlaubt) |
| Anti-Link | Links zu nicht freigegebenen Domains (Subdomains inklusive) |
| Wortfilter | Wortliste mit `*`-Platzhaltern, reguläre Ausdrücke, Normalisierung gegen Leetspeak, Wiederholungen und Akzente |
| Großschreibung | Anteil Großbuchstaben ab Mindestlänge |
| Anti-Raid | N Beitritte in X Sekunden lösen eine Raid-Sperre aus (Alarm, Timeout, Kick oder Bann für weitere Beitritte). Mindestalter für Konten |

Für jede Regel lässt sich die Aktion wählen: löschen, verwarnen, Timeout, kicken oder bannen. Mitglieder mit „Nachrichten verwalten“ oder Administrator sind ausgenommen. Zusätzlich lassen sich Kanäle und Rollen ausnehmen. Bearbeitete Nachrichten werden ebenfalls geprüft.

## Logging

Mögliche Ereignisse: Nachricht gelöscht, gesammelt gelöscht und bearbeitet, Beitritt und Austritt, Rollen- und Nickname-Änderungen, Rollen und Kanäle erstellt, geändert und gelöscht, Voice-Beitritt, -Wechsel und -Austritt, Moderation, Auto-Moderation, Raid, Tickets, Serveränderungen.

Jedes Ereignis wird in der Datenbank gespeichert, live an das Dashboard gesendet und optional als Embed in einen Kanal pro Kategorie gepostet. Weitere Funktionen: CSV-Export, Aufbewahrungsdauer, ignorierte Kanäle.

## Level & XP

| Befehl | Beschreibung |
|---|---|
| `/rank [mitglied]` | Level, Fortschritt, Rang |
| `/leaderboard [zeitraum]` | Rangliste gesamt, 7 Tage oder 30 Tage |

- XP pro Nachricht als Zufallswert zwischen Min und Max, Cooldown, Voice-XP pro Minute (mind. 2 Personen, nicht taub geschaltet).
- Multiplikatoren: global, pro Rolle (höchster zählt) und pro Kanal.
- Levelkurven: Standard `5·L² + 50·L + 100`, linear oder exponentiell. Ändert sich die Kurve, werden alle Level neu berechnet.
- Belohnungen pro Level: Rolle und Coins (Economy). Rollen lassen sich stapeln oder es zählt nur die höchste. „Rollen synchronisieren“ wendet die Belohnungen nachträglich an.
- Level-Up-Nachricht mit Platzhaltern. Ein Level-Up kann auch Automatisierungen auslösen.

## Willkommen

Begrüßungsnachricht (Text oder Embed mit Avatar), Abschiedsnachricht, DM an neue Mitglieder, automatische Rollen für Menschen und Bots (optional verzögert), Testnachricht aus dem Dashboard.

## Tickets

| Befehl | Beschreibung |
|---|---|
| `/ticket add/remove mitglied` | Mitglied zum Ticket hinzufügen oder entfernen (Support) |
| `/ticket claim` | Ticket übernehmen |
| `/ticket priority stufe` | Priorität setzen |
| `/ticket close [grund]` | Ticket schließen (Ersteller oder Support) |

**Ablauf:**

1. Das Panel wird aus dem Dashboard gesendet: bis zu 5 Kategorien als Buttons, darüber als Auswahlmenü.
2. Das Mitglied gibt in einem Formular einen Betreff ein.
3. Der Bot legt einen privaten Kanal an, sichtbar für Ersteller, Support-Rollen und Bot.
4. Im Kanal gibt es Buttons zum Übernehmen und Schließen sowie ein Auswahlmenü für die Priorität.
5. Beim Schließen wird das Transkript gespeichert (Datenbank, Transkript-Kanal als `.txt`, DM an den Ersteller). Der Kanal wird danach gelöscht oder archiviert.

Im Dashboard kannst du Tickets live mitlesen, antworten, übernehmen, die Priorität ändern, sie schließen, Transkripte herunterladen und Statistiken ansehen (Ø Reaktions- und Lösungszeit).

## Economy (virtuell)

| Befehl | Beschreibung |
|---|---|
| `/balance [mitglied]` | Wallet, Bank, Job, Firma, Rang |
| `/daily` | Tägliche Belohnung mit Streak-Bonus |
| `/work` | Arbeiten (Lohn aus Job oder Standard), Firmenbonus |
| `/pay mitglied betrag` | Überweisung (optional mit Steuer) |
| `/deposit` · `/withdraw betrag/alles` | Bank |
| `/shop` · `/buy gegenstand [menge]` · `/inventory` | Shop und Inventar (Rollen-Artikel vergeben die Rolle) |
| `/trade mitglied …` | Handelsangebot (Geld und/oder Gegenstände), Annehmen per Button, 10 Minuten gültig |
| `/job list/join/quit` | Jobs mit Mindestlevel |
| `/company create/info/join/leave/deposit/payout/toggle` | Firmen mit Kasse |
| `/richest` | Rangliste nach Vermögen |

Alle Geldbewegungen sind atomar, ein negativer Kontostand ist ausgeschlossen. Jede Bewegung wird als Transaktion protokolliert. Im Dashboard verwaltest du Shop, Jobs, Firmen und Kontostände (Admin-Korrektur wird protokolliert).

## Automatisierungen

| Auslöser | Konfiguration |
|---|---|
| Mitglied tritt bei / verlässt | – |
| Nachricht enthält | Wörter, Modus (enthält, exakt, beginnt mit, Regex), Kanäle |
| Reaktion | Nachrichten-ID, Emoji |
| Rolle erhalten | Rolle |
| Level erreicht | Level oder jedes Level |
| Zeitplan | Cron-Ausdruck mit Zeitzone |
| Inaktivität | Tage ohne Nachricht (stündliche Prüfung, einmal pro Mitglied) |

**Bedingungen:** Bots ignorieren, erforderliche Rollen, ausgeschlossene Rollen.
**Aktionen:** Nachricht senden (Text oder Embed), Discord-Umfrage senden (2–10 Antworten, Laufzeit bis 32 Tage), antworten, DM, Rolle hinzufügen oder entfernen, Reaktion, Nachricht löschen, Timeout. Jede Aktion kann um bis zu 15 Minuten verzögert werden.
**Platzhalter:** `{user} {username} {userId} {server} {memberCount} {channel} {level} {days} {date}`.

Ein Schutz gegen Endlosschleifen begrenzt die Ausführungen pro Minute. Fehler werden pro Regel angezeigt. Ein Testlauf ist direkt aus dem Dashboard möglich.

| Befehl | Beschreibung |
|---|---|
| `/remind in nachricht` | Erinnerung (max. 1 Jahr, 25 offene pro Nutzer) |

## Voice-Manager

Join-to-Create-Kanäle: Wer beitritt, bekommt einen eigenen Kanal mit Namensvorlage, Limit und den Rechten der Kategorie. Leere Kanäle werden gelöscht, optional verzögert. Nach einem Neustart räumt der Bot verwaiste Kanäle auf.

| Befehl | Beschreibung |
|---|---|
| `/voice name` · `/voice limit` | Umbenennen, Limit (abschaltbar) |
| `/voice lock` · `/voice unlock` | Sperren (abschaltbar) |
| `/voice claim` | Kanal übernehmen, wenn der Besitzer weg ist |
| `/voice transfer mitglied` · `/voice kick mitglied` | Besitz übertragen, Mitglied entfernen |

## Giveaways (Giveaway Manager 2.0)

Gewinnspiele werden im Dashboard erstellt: Preis, Beschreibung, Bild, Farbe, Anzahl Gewinner, sofortiger oder geplanter Start, Ende und Erinnerung vor dem Ende. Der Bot veröffentlicht sie im gewählten Kanal. Mitglieder nehmen per Button teil, ein zweiter Klick zieht die Teilnahme zurück.

- **Teilnahmebedingungen:** benötigte Rollen (eine davon), ausgeschlossene Rollen, Mindestdauer auf dem Server, Mindestalter des Discord-Kontos, nur verifizierte Mitglieder (Membership Screening), maximale Teilnehmerzahl.
- **Steuerung:** pausieren (die pausierte Zeit wird ans Ende angehängt), fortsetzen, verlängern, vorzeitig beenden, abbrechen, archivieren, löschen.
- **Gewinner:** automatische Ziehung zum Endzeitpunkt, Bekanntgabe im Kanal (Antwort auf das Gewinnspiel) und optional per DM. Ersatzgewinner: einen Gewinner ersetzen oder einen zusätzlichen ziehen.
- **Manipulationsschutz (Commit-Reveal):** Beim Erstellen wird ein geheimer 256-Bit-Zufallswert erzeugt, im Embed steht nur seine SHA-256-Prüfsumme. Nach dem Ende wird er offengelegt. Die Reihenfolge ergibt sich aus `HMAC-SHA256(seed, userId)` aufsteigend. Wer den Server verlassen hat, wird übersprungen. Unter „Fairness-Nachweis“ ist alles nachrechenbar.
- **Dashboard:** aktive, geplante, beendete und archivierte Gewinnspiele mit Live-Countdown und Live-Teilnehmerzahl. Pro Gewinnspiel ein Teilnahmeverlauf (Diagramm), eine Teilnehmerliste mit Suche und eine Gewinnerübersicht. Dazu Statistiken: Teilnahmen, einzigartige Teilnehmer, Top-Teilnehmer.
- **Einstellungen:** Button-Text und -Emoji, Rolle, die beim Start angepingt wird, Gewinner-DM sowie Vorlagen für die Bekanntgabe und die Erinnerung.

## Control Center

Die Startseite des Dashboards zeigt live:

- Status von Bot, Backend, PostgreSQL und Redis, jeweils mit Antwortzeit
- einen Health-Score, berechnet aus Dienststatus und Warnungen
- Kennzahlen mit Verlauf
- Systemwarnungen: Bot offline, fehlende Rechte, Modulfehler, Raid-Sperre, fehlerhafte Automatisierungen
- Live-Aktivität, laufende Gewinnspiele, offene Tickets, anstehende und letzte Automatisierungen, Modulstatus
- Schnellaktionen

Welche Widgets angezeigt werden, legst du über „Widgets“ fest.

## Oberfläche

- **Globale Suche** (Strg/⌘ + K): Seiten, Schnellaktionen und Mitglieder.
- **Benachrichtigungszentrum:** Moderationsfälle, Auto-Mod, Raids, neue Tickets, beendete Gewinnspiele und fehlgeschlagene Automatisierungen, jeweils live.
- **Schnellaktionen:** Gewinnspiel erstellen, Umfrage sofort starten, Nachricht senden, Moderationsaktion, Automatisierung erstellen, Statistiken öffnen.
- **Sidebar:** Kategorien einklappbar, die ganze Sidebar lässt sich zur Icon-Leiste verkleinern. Die Einstellungen werden im Browser gespeichert.
