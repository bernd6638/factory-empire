import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { BotStatus } from './types';

export interface LiveEvent<T = any> {
  type: string;
  guildId: string | null;
  data: T;
  ts: number;
}

type Listener = (ev: LiveEvent) => void;

interface LiveCtx {
  connected: boolean;
  bot: BotStatus | null;
  subscribe: (guildId: string | null) => void;
  on: (listener: Listener) => () => void;
}

const Ctx = createContext<LiveCtx | null>(null);

/** Welche Abfragen bei welchem Live-Ereignis neu geladen werden. */
const INVALIDATE: Record<string, string[][]> = {
  'mod.case': [['cases'], ['mod-stats'], ['member']],
  'ticket.created': [['tickets'], ['ticket-stats']],
  'ticket.updated': [['tickets'], ['ticket-stats'], ['ticket']],
  'member.join': [['members']],
  'member.leave': [['members']],
  'voice.created': [['voice']],
  'voice.deleted': [['voice']],
  'voice.state': [['voice']],
  'automation.run': [['automations']],
  'config.updated': [['module'], ['modules'], ['guild']],
  'economy.purchase': [['economy']],
  'economy.trade': [['economy']],
  'level.up': [['leaderboard']],
  'guild.joined': [['guilds']],
  'guild.left': [['guilds']],
};

/** Hält eine WebSocket-Verbindung zum Backend (mit automatischem Neuverbinden). */
export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [bot, setBot] = useState<BotStatus | null>(null);
  const listeners = useRef(new Set<Listener>());
  const wsRef = useRef<WebSocket | null>(null);
  const guildRef = useRef<string | null>(null);
  const retry = useRef(0);

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry.current = 0;
        setConnected(true);
        if (guildRef.current) ws.send(JSON.stringify({ type: 'subscribe', guildId: guildRef.current }));
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        const delay = Math.min(1000 * 2 ** retry.current, 15000);
        retry.current++;
        timer = setTimeout(connect, delay);
      };
      ws.onmessage = (msg) => {
        let ev: LiveEvent;
        try {
          ev = JSON.parse(msg.data);
        } catch {
          return;
        }
        if (ev.type === 'bot.status') setBot(ev.data as BotStatus);
        for (const key of INVALIDATE[ev.type] ?? []) void qc.invalidateQueries({ queryKey: key });
        for (const l of listeners.current) l(ev);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [qc]);

  const subscribe = useCallback((guildId: string | null) => {
    guildRef.current = guildId;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(guildId ? { type: 'subscribe', guildId } : { type: 'unsubscribe' }));
  }, []);

  const on = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  return <Ctx.Provider value={{ connected, bot, subscribe, on }}>{children}</Ctx.Provider>;
}

export function useLiveContext() {
  const c = useContext(Ctx);
  if (!c) throw new Error('LiveProvider fehlt');
  return c;
}

/** Ruft `handler` für jedes Live-Ereignis der angegebenen Typen auf. */
export function useLive(types: string | string[], handler: (ev: LiveEvent) => void) {
  const { on } = useLiveContext();
  const ref = useRef(handler);
  ref.current = handler;
  const key = Array.isArray(types) ? types.join(',') : types;
  useEffect(() => {
    const set = new Set(key.split(','));
    return on((ev) => {
      if (set.has(ev.type) || set.has('*')) ref.current(ev);
    });
  }, [on, key]);
}
