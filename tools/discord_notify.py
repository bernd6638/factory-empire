"""Schickt eine Update-Meldung in den Discord-Channel (läuft automatisch über GitHub Actions).

Nutzt den Webhook aus der Umgebungsvariable DISCORD_WEBHOOK (GitHub-Secret). Ohne Webhook wird
nur angezeigt, was gesendet würde.
"""

import json
import os
import sys
import urllib.request

REPO_RAW = "https://raw.githubusercontent.com/bernd6638/factory-empire/main"
# Rolle, die bei jedem Update gepingt wird: Rollen-ID (Zahl), "everyone" oder leer = niemand.
# Kann auch über die GitHub-Variable DISCORD_ROLE_ID gesetzt werden.
ROLE_ID = "1324453801033465917"


def build_message(info):
    """Große Schrift über Discord-Überschriften (#, ##, ###) direkt in der Nachricht."""
    version = info["version"]
    notes = []
    for entry in info.get("notes", []):
        if entry[0] == version:
            notes = entry[1]
            break
    lines = [f"# 🏭 Factory Empire {version} ist da!", "## ✨ Das ist neu:"]
    lines += [f"### • {n}" for n in notes] or ["### • Verbesserungen und Fehlerbehebungen"]
    lines += ["", "## 🔄 So bekommst du das Update:",
              "### Spiel starten und im Fenster „Update verfügbar“ auf **„Jetzt aktualisieren“** klicken – fertig!",
              "💾 Deine Spielstände bleiben erhalten.",
              "-# Im Mehrspieler sollten alle dieselbe Version haben."]
    if int(info.get("runtime", 1)) > 1 and info.get("download_page"):
        lines.insert(-1, f"⚠️ Diese Version braucht einen neuen Download: {info['download_page']}")
    role = (os.environ.get("DISCORD_ROLE_ID") or ROLE_ID).strip()
    allowed = {"parse": []}
    ping = ""
    if role.lower() in ("everyone", "@everyone"):
        ping, allowed = "@everyone", {"parse": ["everyone"]}
    elif role.isdigit():
        ping, allowed = f"<@&{role}>", {"roles": [role]}
    content = (ping + "\n" if ping else "") + "\n".join(lines)
    return {"username": "Factory Empire", "avatar_url": f"{REPO_RAW}/logo.png",
            "content": content[:1990], "allowed_mentions": allowed}


def main():
    with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "update.json"),
              encoding="utf-8") as f:
        info = json.load(f)
    payload = build_message(info)
    hook = os.environ.get("DISCORD_WEBHOOK", "").strip()
    if not hook:
        print("Kein DISCORD_WEBHOOK gesetzt – würde senden:")
        print(json.dumps(payload, ensure_ascii=False, indent=1))
        return
    req = urllib.request.Request(hook, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json", "User-Agent": "FactoryEmpireBot"})
    with urllib.request.urlopen(req, timeout=15) as r:
        print("Discord:", r.status)


if __name__ == "__main__":
    sys.exit(main())
