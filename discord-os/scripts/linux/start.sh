#!/usr/bin/env bash
# Startet Discord OS (Linux/macOS). Für den Dauerbetrieb siehe docs/DEPLOYMENT.md (systemd / Docker).
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] || { echo "Keine .env gefunden – zuerst 'npm run setup' ausführen."; exit 1; }
command -v docker >/dev/null 2>&1 && docker compose up -d postgres redis >/dev/null 2>&1 || true
[ -f server/dist/index.js ] || npm run build
exec npm start
