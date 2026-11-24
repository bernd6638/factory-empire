# Input Overlay (Xbox-Controller & Tastatur)

Kleines Windows-Programm, das deine Eingaben als durchsichtiges Overlay über Spielen oder dem Desktop anzeigt –
entweder den **weißen Xbox-Series-Controller** oder **Tastatur & Maus**.

## Starten

1. [Python für Windows](https://www.python.org/downloads/) installieren (beim Installieren **„Add python.exe to PATH“** anhaken).
2. Diesen Ordner herunterladen und **`start_overlay.bat`** doppelklicken.

Optional als richtige `.exe`: **`build_exe.bat`** doppelklicken → danach liegt `dist\InputOverlay.exe` bereit,
die du überall hin kopieren (z. B. auf den Desktop) und ohne Python starten kannst.

## Bedienung

Beim Start öffnen sich das **Einstellungsfenster** und das **Overlay**.

| Was | Wie |
|---|---|
| Controller / Tastatur / Automatisch wählen | im Einstellungsfenster, Rechtsklick aufs Overlay oder **Strg+Alt+M** |
| Overlay ein- / ausschalten | Haken „Overlay anzeigen“ oder **Strg+Alt+O** |
| Größer / kleiner | Regler „Größe“, **Mausrad** über dem Overlay oder **Strg+Alt+Plus / Minus** |
| Verschieben | Overlay mit der linken Maustaste ziehen |
| Fixieren (Klicks gehen durchs Overlay ins Spiel) | Haken „Fixieren“ oder **Strg+Alt+L** |
| Durchsichtigkeit | Regler „Deckkraft“ |

Die Tastenkürzel funktionieren auch, während das Spiel im Vordergrund ist.
Im Modus **Automatisch** wechselt das Overlay von selbst, je nachdem ob du gerade Controller oder Tastatur benutzt.
Einstellungen (Position, Größe, Modus) werden automatisch gespeichert.

## In OBS einfügen

Solange das Programm läuft, stellt es das Overlay auch als Seite für OBS bereit – mit echtem durchsichtigem Hintergrund.

1. Im Einstellungsfenster unter **„OBS (Browserquelle)“** auf **Link kopieren** klicken:
   - **Wie Overlay** – zeigt das an, was auch das Overlay gerade zeigt (folgt auch dem Automatisch-Modus)
   - **Controller** / **Tastatur** – zeigt immer nur das eine
2. In OBS: **Quellen → + → Browser** → bei **URL** den Link einfügen (z. B. `http://localhost:8765/`).
3. **Breite 800**, **Höhe 650** eintragen → OK. Danach in OBS einfach größer/kleiner ziehen und platzieren.

Das funktioniert auch, wenn das Overlay auf dem Bildschirm ausgeblendet ist (Strg+Alt+O) – so siehst nur dein Stream die Eingaben.
Wenn OBS vor dem Programm gestartet wird, verbindet sich die Quelle von selbst, sobald das Programm läuft.

## Hinweise

- Der Controller kann per USB, Bluetooth oder Xbox-Wireless-Adapter verbunden sein.
- Damit das Overlay über dem Spiel sichtbar ist, im Spiel **„Randloses Fenster“ / „Borderless“** statt echtem Vollbild einstellen.
- Der Share-Button wird von Windows nicht an Programme weitergegeben und leuchtet deshalb nicht auf.
