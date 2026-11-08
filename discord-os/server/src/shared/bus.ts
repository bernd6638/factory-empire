import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { createRedis, redis } from './redis';
import { childLogger } from './logger';

/**
 * Bus – Kommunikation zwischen Bot und API über Redis Pub/Sub.
 *
 *  • Live-Events  (Bot → API → WebSocket → Dashboard)
 *  • RPC          (API → Bot, z. B. "Mitglied bannen", "Rollen laden")
 *  • Config-Sync  (API → Bot, Cache-Invalidierung nach Einstellungsänderung)
 *
 * Bot und API können im selben Prozess oder getrennt (auch auf mehreren Servern) laufen.
 */

const log = childLogger('bus');

export const CHANNELS = {
  events: 'dos:events',
  rpcRequest: 'dos:rpc:req',
  rpcResponse: 'dos:rpc:res',
  config: 'dos:config',
} as const;

export const BOT_STATUS_KEY = 'dos:bot:status';

export interface LiveEvent<T = unknown> {
  /** null = globales Ereignis (z. B. Bot-Status) */
  guildId: string | null;
  type: string;
  data: T;
  ts: number;
}

export interface ConfigChange {
  guildId: string;
  /** Modul-Schlüssel oder "*" für alles */
  module: string;
}

interface RpcRequest {
  id: string;
  method: string;
  params: unknown;
}

interface RpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export class RpcError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface BotStatus {
  online: boolean;
  ping: number;
  guilds: number;
  users: number;
  uptimeMs: number;
  startedAt: number;
  tag: string | null;
  avatar: string | null;
  id: string | null;
  memoryMb: number;
  updatedAt: number;
}

type EventHandler = (event: LiveEvent) => void;
type ConfigHandler = (change: ConfigChange) => void;
type RpcHandler = (method: string, params: any) => Promise<unknown>;

export class Bus {
  private sub: Redis;
  private pub: Redis;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private eventHandlers = new Set<EventHandler>();
  private configHandlers = new Set<ConfigHandler>();
  private rpcHandler: RpcHandler | null = null;
  private subscribed = new Set<string>();

  constructor(name: string) {
    this.pub = redis();
    this.sub = createRedis(`${name}:sub`);
    this.sub.on('message', (channel, raw) => this.onMessage(channel, raw));
  }

  private async ensureSubscribed(channel: string) {
    if (this.subscribed.has(channel)) return;
    this.subscribed.add(channel);
    await this.sub.subscribe(channel);
  }

  private onMessage(channel: string, raw: string) {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (channel) {
      case CHANNELS.events:
        for (const h of this.eventHandlers) safe(() => h(msg));
        break;
      case CHANNELS.config:
        for (const h of this.configHandlers) safe(() => h(msg));
        break;
      case CHANNELS.rpcResponse: {
        const res = msg as RpcResponse;
        const p = this.pending.get(res.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(res.id);
        if (res.ok) p.resolve(res.result);
        else p.reject(new RpcError(res.error?.code ?? 'ERROR', res.error?.message ?? 'Unbekannter Fehler'));
        break;
      }
      case CHANNELS.rpcRequest:
        void this.handleRpc(msg as RpcRequest);
        break;
    }
  }

  private async handleRpc(req: RpcRequest) {
    if (!this.rpcHandler) return;
    let res: RpcResponse;
    try {
      const result = await this.rpcHandler(req.method, req.params);
      res = { id: req.id, ok: true, result: result ?? null };
    } catch (err: any) {
      const code = err instanceof RpcError ? err.code : 'INTERNAL';
      if (!(err instanceof RpcError)) log.error({ err, method: req.method }, 'RPC-Handler-Fehler');
      res = { id: req.id, ok: false, error: { code, message: err?.message ?? String(err) } };
    }
    await this.pub.publish(CHANNELS.rpcResponse, JSON.stringify(res));
  }

  // ── Live-Events ──
  async publishEvent<T>(guildId: string | null, type: string, data: T): Promise<void> {
    const ev: LiveEvent<T> = { guildId, type, data, ts: Date.now() };
    await this.pub.publish(CHANNELS.events, JSON.stringify(ev));
  }

  async onEvent(handler: EventHandler) {
    this.eventHandlers.add(handler);
    await this.ensureSubscribed(CHANNELS.events);
  }

  // ── Config-Sync ──
  async publishConfigChange(guildId: string, module: string) {
    await this.pub.publish(CHANNELS.config, JSON.stringify({ guildId, module } satisfies ConfigChange));
  }

  async onConfigChange(handler: ConfigHandler) {
    this.configHandlers.add(handler);
    await this.ensureSubscribed(CHANNELS.config);
  }

  // ── RPC ──
  /** Bot-Seite: registriert den Handler für alle RPC-Methoden. */
  async serveRpc(handler: RpcHandler) {
    this.rpcHandler = handler;
    await this.ensureSubscribed(CHANNELS.rpcRequest);
  }

  /** API-Seite: ruft eine Methode im Bot auf. */
  async call<T = unknown>(method: string, params: unknown = {}, timeoutMs = 10_000): Promise<T> {
    await this.ensureSubscribed(CHANNELS.rpcResponse);
    const online = await this.pub.exists(BOT_STATUS_KEY);
    if (!online) throw new RpcError('BOT_OFFLINE', 'Der Bot ist derzeit nicht erreichbar.');
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError('TIMEOUT', 'Der Bot hat nicht rechtzeitig geantwortet.'));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.pub.publish(CHANNELS.rpcRequest, JSON.stringify({ id, method, params } satisfies RpcRequest)).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  async close() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    await this.sub.quit().catch(() => undefined);
  }
}

function safe(fn: () => void) {
  try {
    fn();
  } catch (err) {
    log.error({ err }, 'Bus-Handler-Fehler');
  }
}

export async function getBotStatus(): Promise<BotStatus | null> {
  const raw = await redis().get(BOT_STATUS_KEY);
  return raw ? (JSON.parse(raw) as BotStatus) : null;
}
