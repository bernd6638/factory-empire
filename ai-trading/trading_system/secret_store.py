"""Sichere Speicherung von API-Schlüsseln.

Reihenfolge der Auflösung (erste Quelle gewinnt):
1. Umgebungsvariable (z. B. ``ALPACA_API_KEY``)
2. Verschlüsselter Tresor ``data/secrets.vault`` (Fernet/AES-128-CBC + HMAC,
   Schlüssel per PBKDF2-HMAC-SHA256 mit 600 000 Iterationen aus einem
   Master-Passwort abgeleitet). Das Passwort kommt aus ``TS_VAULT_PASSWORD``.

Schlüssel werden nie geloggt; ``mask()`` liefert eine sichere Darstellung.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path

from .errors import SecretStoreError

KNOWN_SECRETS = {
    "ALPACA_API_KEY": "Alpaca Market Data / Paper-Konto (Key-ID)",
    "ALPACA_API_SECRET": "Alpaca Secret Key",
    "ALPHAVANTAGE_API_KEY": "Alpha Vantage Marktdaten",
    "ANTHROPIC_API_KEY": "Claude API für KI-Marktkommentare (optional)",
}

_ITERATIONS = 600_000


def mask(value: str | None) -> str:
    if not value:
        return "<nicht gesetzt>"
    if len(value) <= 8:
        return "****"
    return f"{value[:3]}…{value[-2:]}"


def _fernet(password: str, salt: bytes):
    try:
        from cryptography.fernet import Fernet
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    except ImportError as exc:  # pragma: no cover
        raise SecretStoreError("Paket 'cryptography' fehlt (pip install cryptography)") from exc
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=_ITERATIONS)
    return Fernet(base64.urlsafe_b64encode(kdf.derive(password.encode("utf-8"))))


class SecretVault:
    """Verschlüsselter Key-Value-Speicher für API-Schlüssel."""

    def __init__(self, path: str | Path, password: str):
        if not password:
            raise SecretStoreError("Leeres Tresor-Passwort ist nicht erlaubt")
        self.path = Path(path)
        self._password = password

    def _load(self) -> dict[str, str]:
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text("utf-8"))
            salt = base64.b64decode(raw["salt"])
            token = raw["data"].encode("ascii")
            plain = _fernet(self._password, salt).decrypt(token)
            return json.loads(plain)
        except SecretStoreError:
            raise
        except Exception as exc:
            raise SecretStoreError("Tresor konnte nicht entschlüsselt werden (falsches Passwort?)") from exc

    def _save(self, data: dict[str, str]) -> None:
        salt = os.urandom(16)
        token = _fernet(self._password, salt).encrypt(json.dumps(data).encode("utf-8"))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"v": 1, "salt": base64.b64encode(salt).decode(), "data": token.decode()}), "utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:  # pragma: no cover - Windows
            pass
        tmp.replace(self.path)

    def get(self, name: str) -> str | None:
        return self._load().get(name)

    def set(self, name: str, value: str) -> None:
        data = self._load()
        data[name] = value
        self._save(data)

    def delete(self, name: str) -> bool:
        data = self._load()
        existed = data.pop(name, None) is not None
        self._save(data)
        return existed

    def names(self) -> list[str]:
        return sorted(self._load())


def get_secret(name: str, vault_path: str | Path | None = None) -> str | None:
    """Liest einen Schlüssel aus Umgebung oder Tresor. Gibt None zurück, wenn nicht vorhanden."""
    value = os.environ.get(name)
    if value:
        return value
    password = os.environ.get("TS_VAULT_PASSWORD")
    if vault_path and password and Path(vault_path).exists():
        return SecretVault(vault_path, password).get(name)
    return None


def secrets_status(vault_path: str | Path | None = None) -> dict[str, dict[str, str | bool]]:
    """Übersicht, welche Zugangsdaten konfiguriert sind (ohne Werte preiszugeben)."""
    out = {}
    for name, desc in KNOWN_SECRETS.items():
        try:
            val = get_secret(name, vault_path)
        except SecretStoreError:
            val = None
        out[name] = {"description": desc, "configured": bool(val), "masked": mask(val)}
    return out
