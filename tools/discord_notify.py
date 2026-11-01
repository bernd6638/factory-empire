"""Schickt eine Update-Meldung in den Discord-Channel (läuft automatisch über GitHub Actions).

Nutzt den Webhook aus der Umgebungsvariable DISCORD_WEBHOOK (GitHub-Secret). Ohne Webhook wird
nur angezeigt, was gesendet würde.
"""

import datetime
import json
import os
import sys
import urllib.request

REPO_RAW = "https://raw.githubusercontent.com/bernd6638/factory-empire/main"
REPO = "bernd6638/factory-empire"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Rolle, die bei jedem Update gepingt wird: Rollen-ID (Zahl), "everyone" oder leer = niemand.
# Kann auch über die GitHub-Variable DISCORD_ROLE_ID gesetzt werden.
ROLE_ID = "everyone"


EMOJIS = [("musik", "🎵"), ("vogel", "🐦"), ("wind", "🌬️"), ("geräusch", "🔊"), ("sound", "🔊"),
          ("regler", "🎚️"), ("einstell", "🎚️"), ("förderband", "⚙️"), ("kurve", "⚙️"), ("chat", "💬"), ("grafik", "🎨"), ("beleucht", "🎨"),
          ("baustelle", "🚧"), ("countdown", "⏳"), ("auftr", "🚚"), ("lkw", "🚚"), ("discord", "🎮"),
          ("update", "🔄"), ("statistik", "📊"), ("erfolg", "🏆"), ("wald", "🌲"), ("fps", "⚡"),
          ("fehler", "🛠️"), ("bug", "🛠️"), ("mehrspieler", "👥"), ("welt", "🌍")]


def _field(note):
    """Ein Punkt der Neuigkeiten -> Discord-Feld mit Emoji, Titel und Beschreibung."""
    low = note.lower()
    emoji = next((e for k, e in EMOJIS if k in low), "✨")
    for sep in (": ", " – ", " - "):
        if sep in note:
            head, rest = note.split(sep, 1)
            if len(head) <= 40:
                return {"name": f"{emoji}  {head}", "value": rest[:1000], "inline": False}
    return {"name": f"{emoji}  Neu", "value": note[:1000], "inline": False}


def _exists(url):
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "FactoryEmpireBot"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status < 400
    except Exception:
        return False


def build_message(info):
    version = info["version"]
    notes = []
    for entry in info.get("notes", []):
        if entry[0] == version:
            notes = entry[1]
            break
    fields = [_field(n) for n in notes[:10]] or [{"name": "✨  Verbesserungen", "value": "Fehlerbehebungen und Feinschliff."}]
    fields.append({"name": "\u200b", "value": "**🔄 So bekommst du das Update:**\n"
                   "Spiel starten  ➜  **„Jetzt aktualisieren“**  ➜  fertig!\n"
                   "💾 Deine Spielstände bleiben erhalten.", "inline": False})
    dl = f"https://github.com/{REPO}/releases/download/v{version}/"
    if _exists(dl + f"FactoryEmpire-Setup-v{version}.exe"):
        links = (f"🪟 **[Windows-Installer (Setup.exe)]({dl}FactoryEmpire-Setup-v{version}.exe)**\n"
                 f"📦 [Windows als ZIP]({dl}FactoryEmpire-Windows-v{version}.zip)   ·   "
                 f"🍎 [Mac]({dl}FactoryEmpire-macOS-v{version}.zip)")
    else:
        links = f"🪟 🍎 **[Hier herunterladen](https://github.com/{REPO}/releases/latest)**"
    fields.append({"name": "📥 Neu dabei? Spiel herunterladen:", "value": links, "inline": False})
    embed = {
        "author": {"name": "FACTORY EMPIRE  ·  PATCH NOTES", "icon_url": f"{REPO_RAW}/logo.png"},
        "title": f"✨ Das ist neu in Version {version}",
        "color": 0xFA9E28,
        "fields": fields,
        "thumbnail": {"url": f"{REPO_RAW}/logo.png"},
        "footer": {"text": "Viel Spaß beim Bauen!  ·  Im Mehrspieler alle auf dieselbe Version updaten",
                   "icon_url": f"{REPO_RAW}/logo.png"},
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    promo = os.path.join(ROOT, "updates", f"promo_{version}.jpg")
    if os.path.exists(promo):
        embed["image"] = {"url": f"{REPO_RAW}/updates/promo_{version}.jpg"}
    if int(info.get("runtime", 1)) > 1 and info.get("download_page"):
        fields.insert(-1, {"name": "⚠️  Neuer Download nötig", "value": info["download_page"]})
    role = (os.environ.get("DISCORD_ROLE_ID") or ROLE_ID).strip()
    allowed = {"parse": []}
    ping = ""
    if role.lower() in ("everyone", "@everyone"):
        ping, allowed = "@everyone", {"parse": ["everyone"]}
    elif role.isdigit():
        ping, allowed = f"<@&{role}>", {"roles": [role]}
    content = "\n".join(x for x in (ping, f"# 🚀 UPDATE {version} IST DA!",
                                       "### Die neue Version ist jetzt im Spiel verfügbar 🎉") if x)
    return {"username": "Factory Empire", "avatar_url": f"{REPO_RAW}/logo.png",
            "content": content, "embeds": [embed], "allowed_mentions": allowed}


def main():
    with open(os.path.join(ROOT, "update.json"), encoding="utf-8") as f:
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
