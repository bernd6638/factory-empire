import { AnimatePresence, motion } from 'framer-motion';
import { AlertOctagon, Bell, CheckCheck, Gavel, Gift, ShieldAlert, Ticket, Workflow, type LucideIcon } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLive, type LiveEvent } from '../../lib/live';
import { cn, relative } from '../../lib/format';
import { useGuildId } from '../../hooks/guild';

export interface Notice {
  id: string;
  kind: 'mod' | 'automod' | 'raid' | 'ticket' | 'giveaway' | 'automation';
  title: string;
  body: string;
  at: number;
  link?: string;
  read: boolean;
}

const ICONS: Record<Notice['kind'], { icon: LucideIcon; tone: string }> = {
  mod: { icon: Gavel, tone: 'text-amber-300 bg-amber-500/10 ring-amber-500/25' },
  automod: { icon: ShieldAlert, tone: 'text-accent-400 bg-accent-500/10 ring-accent-500/25' },
  raid: { icon: AlertOctagon, tone: 'text-red-300 bg-red-500/10 ring-red-500/25' },
  ticket: { icon: Ticket, tone: 'text-electric-400 bg-electric-500/10 ring-electric-500/25' },
  giveaway: { icon: Gift, tone: 'text-brand-300 bg-brand-500/10 ring-brand-500/25' },
  automation: { icon: Workflow, tone: 'text-red-300 bg-red-500/10 ring-red-500/25' },
};

const CASE: Record<string, string> = { WARN: 'Verwarnung', TIMEOUT: 'Timeout', UNTIMEOUT: 'Timeout aufgehoben', KICK: 'Kick', BAN: 'Bann', UNBAN: 'Entbannung', NOTE: 'Notiz' };

/** Wandelt Live-Ereignisse in Benachrichtigungen um (nur relevante, nicht jedes Ereignis). */
function toNotice(ev: LiveEvent): Omit<Notice, 'id' | 'read'> | null {
  const d = ev.data;
  switch (ev.type) {
    case 'mod.case':
      if (!d.active && d.type === 'WARN') return null;
      return { kind: 'mod', title: `Fall #${d.caseNumber}: ${CASE[d.type] ?? d.type}`, body: `${d.userTag ?? d.userId}${d.reason ? ` – ${d.reason}` : ''}`, at: ev.ts, link: 'moderation' };
    case 'automod':
      return { kind: 'automod', title: `Auto-Mod: ${d.label}`, body: `${d.username} · Aktion: ${d.action}`, at: ev.ts, link: 'logs' };
    case 'raid':
      return { kind: 'raid', title: 'Raid erkannt', body: `${d.joins} Beitritte in ${d.intervalSeconds}s – Sperre ${d.lockdownMinutes} Min.`, at: ev.ts, link: 'moderation' };
    case 'ticket.created':
      return { kind: 'ticket', title: `Neues Ticket #${d.number}`, body: d.subject ?? `von ${d.ownerTag ?? 'Unbekannt'}`, at: ev.ts, link: `tickets?ticket=${d.id}` };
    case 'giveaway.updated':
      if (!d.ended) return null;
      return { kind: 'giveaway', title: 'Gewinnspiel beendet', body: d.winners?.length ? `${d.winners.length} Gewinner gezogen` : 'Keine gültigen Teilnehmer', at: ev.ts, link: 'giveaways' };
    case 'automation.run':
      if (!d.error) return null;
      return { kind: 'automation', title: `Automatisierung „${d.name}“ fehlgeschlagen`, body: d.error, at: ev.ts, link: 'automations' };
    default:
      return null;
  }
}

interface Ctx {
  notices: Notice[];
  unread: number;
  markAllRead: () => void;
  clear: () => void;
}
const NoticeCtx = createContext<Ctx>({ notices: [], unread: 0, markAllRead: () => undefined, clear: () => undefined });

/** Sammelt Benachrichtigungen pro Server (im Browser gespeichert, max. 50). */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const guildId = useGuildId();
  const key = `dos:notices:${guildId}`;
  const [notices, setNotices] = useState<Notice[]>([]);
  useEffect(() => {
    try {
      setNotices(JSON.parse(localStorage.getItem(key) ?? '[]'));
    } catch {
      setNotices([]);
    }
  }, [key]);
  const persist = useCallback(
    (next: Notice[]) => {
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* Speicher nicht verfügbar */
      }
    },
    [key],
  );
  useLive(['mod.case', 'automod', 'raid', 'ticket.created', 'giveaway.updated', 'automation.run'], (ev) => {
    if (ev.guildId !== guildId) return;
    const n = toNotice(ev);
    if (!n) return;
    setNotices((prev) => {
      const next = [{ ...n, id: `${ev.type}-${ev.ts}-${Math.random().toString(36).slice(2, 7)}`, read: false }, ...prev].slice(0, 50);
      persist(next);
      return next;
    });
  });
  const markAllRead = () =>
    setNotices((prev) => {
      const next = prev.map((n) => ({ ...n, read: true }));
      persist(next);
      return next;
    });
  const clear = () => {
    setNotices([]);
    persist([]);
  };
  return <NoticeCtx.Provider value={{ notices, unread: notices.filter((n) => !n.read).length, markAllRead, clear }}>{children}</NoticeCtx.Provider>;
}

export function useNotices() {
  return useContext(NoticeCtx);
}

export function NotificationBell() {
  const { notices, unread, markAllRead, clear } = useNotices();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const guildId = useGuildId();
  useEffect(() => {
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="relative rounded-xl border border-line bg-panel-2/70 p-2.5 text-fg-muted transition hover:border-line-strong hover:text-fg" aria-label="Benachrichtigungen">
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-accent-500 px-1 text-[10px] font-bold text-white shadow-glow">{unread > 9 ? '9+' : unread}</span>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.98 }} transition={{ duration: 0.15 }} className="card absolute right-0 z-50 mt-2 w-[min(380px,calc(100vw-2rem))] overflow-hidden bg-panel shadow-2xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div className="font-semibold">Benachrichtigungen</div>
              <div className="flex gap-1">
                <button onClick={markAllRead} className="rounded-lg p-1.5 text-fg-subtle hover:bg-panel-3 hover:text-fg" title="Alle als gelesen markieren">
                  <CheckCheck className="h-4 w-4" />
                </button>
                <button onClick={clear} className="rounded-lg px-2 py-1 text-xs text-fg-subtle hover:bg-panel-3 hover:text-fg">
                  Leeren
                </button>
              </div>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              {notices.length === 0 ? (
                <div className="px-6 py-10 text-center text-sm text-fg-subtle">
                  <Bell className="mx-auto mb-3 h-8 w-8 opacity-40" />
                  Keine Benachrichtigungen. Moderation, Tickets, Raids und Gewinnspiele erscheinen hier live.
                </div>
              ) : (
                notices.map((n) => {
                  const I = ICONS[n.kind];
                  return (
                    <button
                      key={n.id}
                      onClick={() => {
                        setOpen(false);
                        markAllRead();
                        if (n.link) navigate(`/guild/${guildId}/${n.link}`);
                      }}
                      className={cn('flex w-full items-start gap-3 border-b border-line/50 px-4 py-3 text-left transition hover:bg-white/[0.03]', !n.read && 'bg-brand-500/[0.05]')}
                    >
                      <div className={cn('mt-0.5 rounded-lg p-2 ring-1', I.tone)}>
                        <I.icon className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          {n.title}
                          {!n.read && <span className="h-1.5 w-1.5 rounded-full bg-brand-400" />}
                        </div>
                        <div className="truncate text-xs text-fg-muted">{n.body}</div>
                        <div className="mt-0.5 text-[11px] text-fg-subtle">{relative(new Date(n.at))}</div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
