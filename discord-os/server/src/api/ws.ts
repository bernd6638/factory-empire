import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { Request, Response } from 'express';
import { env } from '../shared/env';
import { getBotStatus, type LiveEvent } from '../shared/bus';
import { ACCESS } from '../shared/access';
import { childLogger } from '../shared/logger';
import { sessionMiddleware } from './session';
import { resolveAccess } from './access';
import { apiBus } from './bus';

const log = childLogger('ws');

/** Ereignisse, die nur Moderatoren (und höher) live sehen dürfen. */
const MODERATOR_EVENTS = new Set(['log', 'mod.case', 'automod', 'raid', 'ticket.created', 'ticket.updated', 'ticket.message']);

interface Client {
  ws: WebSocket;
  req: Request;
  userId: string;
  guildId: string | null;
  access: number;
  alive: boolean;
}

/**
 * WebSocket-Server für Live-Updates.
 * Authentifizierung über das Session-Cookie; Clients abonnieren genau einen Server.
 */
export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const clients = new Set<Client>();
  const allowedOrigin = new URL(env().PUBLIC_URL).origin;

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url?.startsWith('/ws')) return socket.destroy();
    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    sessionMiddleware()(req as Request, {} as Response, () => {
      const r = req as Request;
      if (!r.session?.user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, r));
    });
  });

  wss.on('connection', (ws: WebSocket, req: Request) => {
    const client: Client = { ws, req, userId: req.session.user!.id, guildId: null, access: 0, alive: true };
    clients.add(client);
    ws.on('pong', () => (client.alive = true));
    ws.on('close', () => clients.delete(client));
    ws.on('error', () => clients.delete(client));
    ws.on('message', async (raw) => {
      let msg: { type?: string; guildId?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'subscribe' && typeof msg.guildId === 'string' && /^\d{15,22}$/.test(msg.guildId)) {
        try {
          const access = await resolveAccess(req.session, msg.guildId);
          if (access < ACCESS.VIEWER) {
            ws.send(JSON.stringify({ type: 'error', data: { message: 'Kein Zugriff auf diesen Server' } }));
            return;
          }
          client.guildId = msg.guildId;
          client.access = access;
          ws.send(JSON.stringify({ type: 'subscribed', guildId: msg.guildId, ts: Date.now() }));
        } catch (err) {
          log.debug({ err }, 'Abonnement fehlgeschlagen');
        }
      } else if (msg.type === 'unsubscribe') {
        client.guildId = null;
      }
    });
    void getBotStatus().then((status) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'bot.status', guildId: null, data: status ?? { online: false }, ts: Date.now() })));
  });

  // Verbindungen ohne Antwort aufräumen
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        clients.delete(c);
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 30_000);

  void apiBus().onEvent((ev: LiveEvent) => {
    const payload = JSON.stringify(ev);
    for (const c of clients) {
      if (c.ws.readyState !== WebSocket.OPEN) continue;
      if (ev.guildId === null) {
        c.ws.send(payload);
      } else if (c.guildId === ev.guildId) {
        if (MODERATOR_EVENTS.has(ev.type) && c.access < ACCESS.MODERATOR) continue;
        c.ws.send(payload);
      }
    }
  });

  return () => {
    clearInterval(heartbeat);
    for (const c of clients) c.ws.close(1001, 'Server wird beendet');
    wss.close();
  };
}
