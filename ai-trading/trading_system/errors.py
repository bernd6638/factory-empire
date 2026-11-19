"""Zentrale Fehlerklassen."""


class TradingSystemError(Exception):
    """Basisklasse aller System-Fehler."""


class ConfigError(TradingSystemError):
    """Ungültige oder unsichere Konfiguration."""


class LiveTradingForbiddenError(ConfigError):
    """Wird ausgelöst, sobald irgendetwas versucht, Echtgeldhandel zu aktivieren."""


class DataProviderError(TradingSystemError):
    """Marktdaten konnten nicht geladen werden."""


class InsufficientDataError(DataProviderError):
    """Zu wenige Kerzen für die Analyse."""


class OrderRejectedError(TradingSystemError):
    """Simulierte Order wurde vom Paper-Broker oder Risikomanagement abgelehnt."""


class SecretStoreError(TradingSystemError):
    """Fehler beim Ver-/Entschlüsseln des Schlüsseltresors."""
