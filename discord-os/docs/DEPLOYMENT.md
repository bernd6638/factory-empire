# Hosting auf einem Server

Für den Dauerbetrieb eignet sich ein Linux-Server, z. B. Ubuntu 24.04 mit mindestens 1 vCPU und 1–2 GB RAM. Es gibt zwei Wege.

## Variante A: Docker (empfohlen)

```bash
git clone <repo> discord-os && cd discord-os
cp .env.example .env
# .env bearbeiten:
#  - Discord-Zugangsdaten
#  - SESSION_SECRET  (openssl rand -hex 48)
#  - ENCRYPTION_KEY  (openssl rand -hex 32)
#  - PUBLIC_URL=https://dashboard.deine-domain.de
#  - TRUST_PROXY=true
docker compose --profile app up -d --build
docker compose logs -f app
```

- `DATABASE_URL` und `REDIS_URL` setzt die Compose-Datei für den Container automatisch.
- Beim Start wendet der Container die Migrationen an. Alle Dienste starten nach einem Reboot automatisch (`restart: unless-stopped`).
- Ändere für die Produktion das PostgreSQL-Passwort in `docker-compose.yml` und in der `DATABASE_URL` des `app`-Dienstes.

**Update:** `git pull && docker compose --profile app up -d --build`

## Variante B: Node.js + systemd

```bash
# Voraussetzungen
sudo apt install -y postgresql redis-server
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs

sudo -u postgres psql -c "CREATE USER discordos WITH PASSWORD 'SICHERES_PASSWORT';" -c "CREATE DATABASE discordos OWNER discordos;"

git clone <repo> /opt/discord-os && cd /opt/discord-os
npm run setup            # erzeugt .env + Schlüssel, installiert, migriert, baut
nano .env                # Zugangsdaten, PUBLIC_URL, TRUST_PROXY=true, NODE_ENV=production
```

`/etc/systemd/system/discord-os.service`:

```ini
[Unit]
Description=Discord OS
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=discordos
WorkingDirectory=/opt/discord-os
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin discordos && sudo chown -R discordos /opt/discord-os
sudo systemctl daemon-reload && sudo systemctl enable --now discord-os
journalctl -u discord-os -f
```

**Update:** `git pull && npm install && npm run build && sudo systemctl restart discord-os`

## Reverse-Proxy mit HTTPS

### Caddy (automatische Zertifikate)

```
dashboard.deine-domain.de {
    reverse_proxy 127.0.0.1:3001
}
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name dashboard.deine-domain.de;
    # ssl_certificate … (z. B. certbot)

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Wichtig:

- `PUBLIC_URL` muss die HTTPS-Adresse sein. Das Session-Cookie ist dann automatisch `secure`.
- `TRUST_PROXY=true` setzen, damit Rate Limiting und Audit-Log die echte Client-IP sehen.
- Bei Discord die Redirect-URL `https://dashboard.deine-domain.de/api/auth/callback` eintragen.
- Port 3001 nicht öffentlich freigeben, z. B. `API_HOST=127.0.0.1` setzen.

## Skalierung

Bot und API kommunizieren nur über Redis. Für größere Installationen:

- `npm run start:bot`: genau **ein** Bot-Prozess.
- `npm run start:api`: beliebig viele API-Instanzen hinter einem Load-Balancer. Sessions und Rate Limits liegen in Redis, WebSocket-Ereignisse erhalten alle Instanzen über Pub/Sub.

## Backups

```bash
# PostgreSQL-Dump (täglich per Cron)
pg_dump -U discordos -h localhost discordos | gzip > /backup/discordos-$(date +%F).sql.gz
# Docker-Variante
docker compose exec -T postgres pg_dump -U discordos discordos | gzip > discordos-$(date +%F).sql.gz
```

Redis enthält nur Sessions, Caches und Ratenzähler. Ein Verlust meldet lediglich alle Nutzer ab.

## Überwachung

- Health-Check: `GET /api/meta/health` liefert `200` bei erreichbarer Datenbank und enthält `bot: true|false`.
- Logs: JSON-Logs (pino) über `journalctl` bzw. `docker compose logs`. Die Detailtiefe steuert `LOG_LEVEL`.
- Fehler pro Modul zeigt das Dashboard unter **Plugins**.
