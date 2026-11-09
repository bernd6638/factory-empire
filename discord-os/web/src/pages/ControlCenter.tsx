import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  Gift,
  LayoutDashboard,
  MessageSquare,
  Puzzle,
  Radio,
  Server,
  SlidersHorizontal,
  Ticket,
  Users,
  Wifi,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useTick } from '../lib/tick';
import { useLive } from '../lib/live';
import { cn, compact, duration, num, relative } from '../lib/format';
import type { BotStatus, LogEntry, ModuleKey } from '../lib/types';
import { useGuild, useGuildId, useLookup } from '../hooks/guild';
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingBlock, StatCard, Switch } from '../components/ui/core';
import { useQuickActions } from '../components/layout/commands';
import { useMe } from '../components/layout/AuthGate';

interface Control {
  system: { bot: BotStatus | null; backend: { ok: boolean; uptimeSec: number; memoryMb: number; node: string }; database: { ok: boolean; ms: number }; redis: { ok: boolean; ms: number } };
  activeServers: number;
  members: number;
  online: number | null;
  tickets: { open: number; latest: { id: number; number: number; subject: string | null; priority: string; status: string; createdAt: string; ownerTag: string | null }[] };
  giveaways: { id: number; prize: string; status: string; endsAt: string; startsAt: string; entries: number }[];
  automations: { total: number; enabled: number; next: { id: number; name: string; nextRunAt: string }[]; recent: { id: number; name: string; lastRunAt: string; lastError: string | null }[] };
  cases24h: number;
  modules: Record<ModuleKey, boolean>;
  warnings: { level: 'critical' | 'warning' | 'info'; title: string; detail: string; link?: string }[];
}

interface Overview {
  totals: { members: number; messagesToday: number; messages7d: number; joins7d: number };
  series: { date: string; messages: number; members: number | null; joins: number }[];
  recentLogs: LogEntry[];
}

const WIDGETS = [
  { id: 'kpis', label: 'Kennzahlen' },
  { id: 'system', label: 'Systemstatus' },
  { id: 'warnings', label: 'Warnungen' },
  { id: 'actions', label: 'Schnellaktionen' },
  { id: 'activity', label: 'Live-Aktivität' },
  { id: 'giveaways', label: 'Gewinnspiele' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'automations', label: 'Automatisierungen' },
  { id: 'modules', label: 'Modulstatus' },
] as const;
type WidgetId = (typeof WIDGETS)[number]['id'];

const MODULE_LABEL: Record<ModuleKey, string> = { moderation: 'Moderation', automod: 'Auto-Mod', logging: 'Logging', leveling: 'Level & XP', welcome: 'Willkommen', tickets: 'Tickets', economy: 'Economy', automation: 'Automation', voice: 'Voice', giveaways: 'Giveaways', voiceai: 'KI-Sprache' };

export function countdown(to: string | Date, now: number) {
  const diff = Math.max(0, new Date(to).getTime() - now) / 1000;
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = Math.floor(diff % 60);
  if (d) return `${d}T ${h}h ${m}m`;
  if (h) return `${h}h ${m}m ${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** Zeigt einen Countdown; nur diese kleine Komponente wird jede Sekunde neu gezeichnet. */
function LiveCountdown({ to, prefix = '' }: { to: string; prefix?: string }) {
  const now = useTick();
  return <>{prefix}{countdown(to, now)}</>;
}

/** Ehrlich berechneter Gesundheitswert aus Dienststatus und Warnungen. */
function healthScore(c: Control) {
  let score = 100;
  if (!c.system.bot?.online) score -= 40;
  if (!c.system.database.ok) score -= 40;
  if (!c.system.redis.ok) score -= 25;
  for (const w of c.warnings) score -= w.level === 'critical' ? 15 : w.level === 'warning' ? 6 : 2;
  if ((c.system.bot?.ping ?? 0) > 400) score -= 5;
  return Math.max(0, Math.min(100, score));
}

function HealthRing({ score }: { score: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const color = score >= 85 ? '#34d399' : score >= 60 ? '#fbbf24' : '#f87171';
  return (
    <div className="relative h-36 w-36">
      <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90">
        <circle cx="64" cy="64" r={r} fill="none" stroke="rgb(255 255 255 / 0.06)" strokeWidth="10" />
        <motion.circle cx="64" cy="64" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - score / 100) }} transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-semibold tabular-nums">{score}</span>
        <span className="text-[10px] tracking-[0.14em] text-fg-subtle uppercase">Health</span>
      </div>
    </div>
  );
}

function ServiceRow({ icon: Icon, label, ok, detail }: { icon: LucideIcon; label: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line/70 bg-white/[0.015] px-3.5 py-3">
      <div className={cn('rounded-lg p-2 ring-1', ok ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/25' : 'bg-red-500/10 text-red-300 ring-red-500/25')}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-fg-subtle">{detail}</div>
      </div>
      <span className={cn('flex items-center gap-1.5 text-xs font-medium', ok ? 'text-emerald-300' : 'text-red-300')}>
        <span className={cn('h-2 w-2 rounded-full', ok ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' : 'bg-red-400')} />
        {ok ? 'Online' : 'Gestört'}
      </span>
    </div>
  );
}

function WidgetSettings({ hidden, setHidden }: { hidden: WidgetId[]; setHidden: (v: WidgetId[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-xl border border-line bg-white/[0.02] px-3 py-2 text-sm text-fg-muted transition hover:border-line-strong hover:text-fg">
        <SlidersHorizontal className="h-4 w-4" /> Widgets
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="card absolute right-0 z-30 mt-2 w-64 bg-panel p-3 shadow-2xl">
            <div className="mb-2 text-[10px] font-semibold tracking-[0.12em] text-fg-subtle uppercase">Angezeigte Widgets</div>
            {WIDGETS.map((w) => (
              <Switch key={w.id} label={<span className="text-sm font-normal">{w.label}</span>} checked={!hidden.includes(w.id)} onChange={(v) => setHidden(v ? hidden.filter((x) => x !== w.id) : [...hidden, w.id])} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const CATEGORY_TONE: Record<string, string> = { messages: 'bg-electric-400', members: 'bg-emerald-400', roles: 'bg-accent-400', channels: 'bg-brand-400', moderation: 'bg-red-400', voice: 'bg-amber-400', server: 'bg-fg-subtle' };

export default function ControlCenterPage() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: guild } = useGuild();
  const { channelName } = useLookup();
  const { actions, run } = useQuickActions();
  const [hidden, setHiddenState] = useState<WidgetId[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('dos:cc-hidden') ?? '[]');
    } catch {
      return [];
    }
  });
  const setHidden = (v: WidgetId[]) => {
    setHiddenState(v);
    try {
      localStorage.setItem('dos:cc-hidden', JSON.stringify(v));
    } catch {
      /* ignorieren */
    }
  };
  const show = (id: WidgetId) => !hidden.includes(id);

  const control = useQuery({ queryKey: ['control', guildId], queryFn: () => api.get<Control>(`/guilds/${guildId}/control`), refetchInterval: 30_000 });
  const overview = useQuery({ queryKey: ['overview', guildId, 14], queryFn: () => api.get<Overview>(`/guilds/${guildId}/overview?days=14`), refetchInterval: 120_000 });

  const [feed, setFeed] = useState<{ id: string; category: string; summary: string; at: string }[]>([]);
  useLive('log', (ev) => setFeed((f) => [{ id: `log-${ev.data.id}`, category: ev.data.category, summary: ev.data.summary, at: ev.data.createdAt }, ...f].slice(0, 30)));
  useLive(['ticket.created', 'ticket.updated', 'giveaway.updated', 'giveaway.entry', 'automation.run', 'raid', 'bot.status'], () => void qc.invalidateQueries({ queryKey: ['control', guildId] }));

  const allFeed = useMemo(() => {
    const base = (overview.data?.recentLogs ?? []).map((l) => ({ id: `log-${l.id}`, category: l.category, summary: l.summary, at: l.createdAt }));
    const seen = new Set<string>();
    return [...feed, ...base].filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true))).slice(0, 12);
  }, [feed, overview.data]);

  if (control.isLoading) return <LoadingBlock />;
  if (control.error || !control.data) return <ErrorState error={control.error} onRetry={() => control.refetch()} />;
  const c = control.data;
  const score = healthScore(c);
  const series = overview.data?.series ?? [];
  const hour = new Date().getHours();
  const greet = hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Guten Tag' : 'Guten Abend';
  const critical = c.warnings.filter((w) => w.level === 'critical').length;

  return (
    <>
      {/* Hero */}
      <Card className="mb-6 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(600px_220px_at_0%_0%,rgb(88_101_255/0.22),transparent_70%),radial-gradient(500px_220px_at_100%_100%,rgb(168_85_247/0.16),transparent_70%)]" />
        <div className="relative flex flex-col gap-6 p-6 md:flex-row md:items-center md:p-8">
          <div className="flex-1">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-brand-500/30 bg-brand-500/10 px-3 py-1 text-[11px] font-medium tracking-wide text-brand-300">
              <LayoutDashboard className="h-3.5 w-3.5" /> CONTROL CENTER
            </div>
            <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
              {greet}, <span className="gradient-text">{me?.globalName ?? me?.username}</span>
            </h1>
            <p className="mt-2 max-w-xl text-fg-muted">
              {guild?.name} · {critical ? <span className="text-red-300">{critical} kritische Warnung{critical > 1 ? 'en' : ''}</span> : c.warnings.length ? `${c.warnings.length} Hinweise` : 'Alle Systeme laufen stabil.'}
            </p>
            <div className="mt-5 flex flex-wrap gap-6 text-sm">
              <div><div className="text-fg-subtle">Bot-Server</div><div className="text-lg font-semibold tabular-nums">{num(c.activeServers)}</div></div>
              <div><div className="text-fg-subtle">Latenz</div><div className="text-lg font-semibold tabular-nums">{c.system.bot?.online ? `${c.system.bot.ping} ms` : '—'}</div></div>
              <div><div className="text-fg-subtle">Uptime Bot</div><div className="text-lg font-semibold tabular-nums">{c.system.bot?.online ? duration((c.system.bot.uptimeMs ?? 0) / 1000) : '—'}</div></div>
              <div><div className="text-fg-subtle">Fälle (24 h)</div><div className="text-lg font-semibold tabular-nums">{num(c.cases24h)}</div></div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <HealthRing score={score} />
            <div className="self-start">
              <WidgetSettings hidden={hidden} setHidden={setHidden} />
            </div>
          </div>
        </div>
      </Card>

      {show('kpis') && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Mitglieder" value={num(c.members)} icon={Users} live hint={overview.data ? `+${overview.data.totals.joins7d} in 7 Tagen` : undefined} spark={series.map((s) => s.members ?? 0).filter(Boolean)} />
          <StatCard label="Online" value={c.online === null ? '—' : num(c.online)} icon={Wifi} accent="green" hint={c.online !== null && c.members ? `${Math.round((c.online / c.members) * 100)} % aktiv` : 'Erfassung alle 10 Min.'} delay={0.04} />
          <StatCard label="Nachrichten heute" value={num(overview.data?.totals.messagesToday)} icon={MessageSquare} accent="violet" live hint={`${compact(overview.data?.totals.messages7d)} in 7 Tagen`} spark={series.map((s) => s.messages)} delay={0.08} />
          <StatCard label="Offene Tickets" value={num(c.tickets.open)} icon={Ticket} accent="blue" hint={`${c.giveaways.filter((g) => g.status === 'ACTIVE').length} aktive Gewinnspiele`} delay={0.12} />
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {show('warnings') && c.warnings.length > 0 && (
            <Card>
              <CardHeader title="Systemwarnungen" description="Automatisch aus allen Modulen erkannt" icon={AlertTriangle} />
              <div className="divide-y divide-line/60">
                {c.warnings.map((w, i) => {
                  const tone = w.level === 'critical' ? 'text-red-300 bg-red-500/10 ring-red-500/30' : w.level === 'warning' ? 'text-amber-300 bg-amber-500/10 ring-amber-500/30' : 'text-electric-400 bg-electric-500/10 ring-electric-500/30';
                  const body = (
                    <div className="flex items-start gap-3 px-5 py-3.5">
                      <div className={cn('mt-0.5 rounded-lg p-1.5 ring-1', tone)}><AlertTriangle className="h-3.5 w-3.5" /></div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium">{w.title}</div>
                        <div className="truncate text-xs text-fg-muted">{w.detail}</div>
                      </div>
                      {w.link && <ArrowUpRight className="h-4 w-4 text-fg-subtle" />}
                    </div>
                  );
                  return w.link ? <Link key={i} to={`/guild/${guildId}/${w.link}`} className="block transition hover:bg-white/[0.025]">{body}</Link> : <div key={i}>{body}</div>;
                })}
              </div>
            </Card>
          )}

          {show('actions') && (
            <Card>
              <CardHeader title="Schnellaktionen" description="Auch über die Suche erreichbar (Strg/⌘ + K)" icon={Zap} />
              <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
                {actions.map((a, i) => (
                  <motion.button key={a.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }} onClick={() => run(a.id)} className="group relative overflow-hidden rounded-xl border border-line bg-white/[0.015] p-4 text-left transition hover:-translate-y-0.5 hover:border-brand-500/40 hover:bg-brand-500/[0.06]">
                    <div className="mb-3 inline-flex rounded-xl bg-gradient-to-br from-brand-500/25 to-accent-500/10 p-2.5 text-brand-300 ring-1 ring-brand-500/25 transition group-hover:shadow-glow"><a.icon className="h-5 w-5" /></div>
                    <div className="text-sm font-semibold">{a.label}</div>
                    <div className="text-xs text-fg-subtle">{a.description}</div>
                    <ArrowUpRight className="absolute top-4 right-4 h-4 w-4 text-fg-subtle opacity-0 transition group-hover:opacity-100" />
                  </motion.button>
                ))}
              </div>
            </Card>
          )}

          {show('activity') && (
            <Card>
              <CardHeader title="Live-Aktivität" icon={Radio} actions={<span className="flex items-center gap-2 text-xs text-emerald-300"><span className="h-2 w-2 animate-pulse-soft rounded-full bg-emerald-400" />Echtzeit</span>} />
              {allFeed.length === 0 ? (
                <EmptyState icon={Activity} title="Noch keine Aktivität" description="Ereignisse erscheinen hier sofort, sobald das Logging-Modul etwas erfasst." />
              ) : (
                <ol className="relative px-5 py-3">
                  <span className="absolute top-5 bottom-5 left-[27px] w-px bg-gradient-to-b from-brand-500/40 via-line to-transparent" />
                  {allFeed.map((f) => (
                    <motion.li key={f.id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="relative flex items-start gap-4 py-2.5">
                      <span className={cn('relative z-10 mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-panel', CATEGORY_TONE[f.category] ?? 'bg-fg-subtle')} />
                      <span className="flex-1 text-sm leading-relaxed text-fg/90">{f.summary.replace(/<#(\d+)>/g, (_, id: string) => channelName(id)).replace(/<@!?(\d+)>/g, '@$1')}</span>
                      <span className="shrink-0 text-xs text-fg-subtle">{relative(f.at)}</span>
                    </motion.li>
                  ))}
                </ol>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-4">
          {show('system') && (
            <Card>
              <CardHeader title="Systemstatus" description={`Backend seit ${duration(c.system.backend.uptimeSec)} · ${c.system.backend.memoryMb} MB`} icon={Cpu} />
              <div className="space-y-2.5 p-4">
                <ServiceRow icon={Bot} label="Discord-Bot" ok={!!c.system.bot?.online} detail={c.system.bot?.online ? `${c.system.bot.tag} · ${c.system.bot.ping} ms` : 'Kein Heartbeat'} />
                <ServiceRow icon={Server} label="Backend & API" ok={c.system.backend.ok} detail={`Node ${c.system.backend.node}`} />
                <ServiceRow icon={Database} label="PostgreSQL" ok={c.system.database.ok} detail={`${c.system.database.ms} ms Antwortzeit`} />
                <ServiceRow icon={Zap} label="Redis" ok={c.system.redis.ok} detail={`${c.system.redis.ms} ms Antwortzeit`} />
              </div>
            </Card>
          )}

          {show('giveaways') && (
            <Card>
              <CardHeader title="Gewinnspiele" icon={Gift} actions={<Link to={`/guild/${guildId}/giveaways`} className="text-xs text-brand-300 hover:underline">Alle</Link>} />
              {c.giveaways.length === 0 ? (
                <p className="px-5 py-6 text-center text-sm text-fg-subtle">Keine laufenden Gewinnspiele</p>
              ) : (
                <div className="space-y-2 p-4">
                  {c.giveaways.map((g) => (
                    <Link key={g.id} to={`/guild/${guildId}/giveaways?open=${g.id}`} className="block rounded-xl border border-line/70 bg-white/[0.015] p-3 transition hover:border-brand-500/40">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{g.prize}</span>
                        <Badge color={g.status === 'ACTIVE' ? 'green' : g.status === 'PAUSED' ? 'yellow' : 'blue'}>{g.status === 'ACTIVE' ? 'Live' : g.status === 'PAUSED' ? 'Pausiert' : 'Geplant'}</Badge>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between text-xs text-fg-muted">
                        <span className="flex items-center gap-1"><Users className="h-3 w-3" />{num(g.entries)}</span>
                        <span className="flex items-center gap-1 font-mono tabular-nums"><Clock className="h-3 w-3" />{g.status === 'PAUSED' ? 'angehalten' : <LiveCountdown to={g.status === 'SCHEDULED' ? g.startsAt : g.endsAt} prefix={g.status === 'SCHEDULED' ? 'Start in ' : ''} />}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Card>
          )}

          {show('tickets') && (
            <Card>
              <CardHeader title="Aktuelle Tickets" icon={Ticket} actions={<Link to={`/guild/${guildId}/tickets`} className="text-xs text-brand-300 hover:underline">Alle</Link>} />
              {c.tickets.latest.length === 0 ? (
                <div className="flex items-center justify-center gap-2 px-5 py-6 text-sm text-fg-subtle"><CheckCircle2 className="h-4 w-4 text-emerald-400" /> Keine offenen Tickets</div>
              ) : (
                <div className="divide-y divide-line/60">
                  {c.tickets.latest.map((t) => (
                    <Link key={t.id} to={`/guild/${guildId}/tickets?ticket=${t.id}`} className="flex items-center gap-3 px-5 py-2.5 text-sm transition hover:bg-white/[0.025]">
                      <span className="font-mono text-xs text-fg-subtle">#{t.number}</span>
                      <span className="flex-1 truncate">{t.subject ?? t.ownerTag ?? 'Ticket'}</span>
                      <span className="text-xs text-fg-subtle">{relative(t.createdAt)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </Card>
          )}

          {show('automations') && (
            <Card>
              <CardHeader title="Automatisierungen" description={`${c.automations.enabled} von ${c.automations.total} aktiv`} icon={Workflow} />
              <div className="space-y-1 p-4 text-sm">
                {c.automations.next.map((a) => (
                  <div key={`n-${a.id}`} className="flex items-center gap-2"><Clock className="h-3.5 w-3.5 text-brand-300" /><span className="flex-1 truncate">{a.name}</span><span className="text-xs text-fg-subtle">{relative(a.nextRunAt)}</span></div>
                ))}
                {c.automations.recent.map((a) => (
                  <div key={`r-${a.id}`} className="flex items-center gap-2"><span className={cn('h-2 w-2 rounded-full', a.lastError ? 'bg-red-400' : 'bg-emerald-400')} /><span className="flex-1 truncate text-fg-muted">{a.name}</span><span className="text-xs text-fg-subtle">{relative(a.lastRunAt)}</span></div>
                ))}
                {!c.automations.next.length && !c.automations.recent.length && <p className="py-3 text-center text-fg-subtle">Noch keine Ausführungen</p>}
              </div>
            </Card>
          )}

          {show('modules') && (
            <Card>
              <CardHeader title="Modulstatus" icon={Puzzle} actions={<Link to={`/guild/${guildId}/plugins`} className="text-xs text-brand-300 hover:underline">Verwalten</Link>} />
              <div className="grid grid-cols-2 gap-2 p-4">
                {(Object.keys(c.modules) as ModuleKey[]).map((k) => (
                  <div key={k} className="flex items-center gap-2 rounded-lg border border-line/60 bg-white/[0.015] px-2.5 py-2 text-xs">
                    <span className={cn('h-1.5 w-1.5 rounded-full', c.modules[k] ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-fg-subtle')} />
                    <span className={c.modules[k] ? 'text-fg' : 'text-fg-subtle'}>{MODULE_LABEL[k] ?? k}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
