import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Activity, Bot, Cpu, Gauge, Gavel, MessageSquare, Radio, Server, Ticket, UserMinus, UserPlus, Users, Wifi } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../lib/api';
import { useLive, useLiveContext, type LiveEvent } from '../lib/live';
import { avatarUrl, compact, duration, num, relative, shortDay } from '../lib/format';
import type { LogEntry } from '../lib/types';
import { useGuild, useGuildId, useLookup } from '../hooks/guild';
import { Avatar, Badge, Card, CardHeader, EmptyState, ErrorState, KeyValue, LoadingBlock, PageHeader, Select, StatCard } from '../components/ui/core';
import { CHART, ChartTooltip, GradientDefs, PALETTE, axisProps } from '../components/ui/chart';

interface Overview {
  totals: { members: number; online: number | null; messagesToday: number; messages7d: number; joins7d: number; leaves7d: number; modActions7d: number; openTickets: number };
  series: { date: string; messages: number; joins: number; leaves: number; modActions: number; voiceMinutes: number; members: number | null; online: number | null }[];
  hourly: { hour: string; messages: number; joins: number }[];
  modByType: { type: string; count: number }[];
  recentLogs: LogEntry[];
  topMembers: { userId: string; username: string; avatar: string | null; messages: number; xp: number }[];
}

const CASE_LABEL: Record<string, string> = { WARN: 'Verwarnung', TIMEOUT: 'Timeout', UNTIMEOUT: 'Timeout aufgehoben', KICK: 'Kick', BAN: 'Bann', UNBAN: 'Entbannung', NOTE: 'Notiz' };
const CATEGORY_COLOR: Record<string, 'brand' | 'violet' | 'green' | 'yellow' | 'red' | 'blue' | 'gray'> = { messages: 'blue', members: 'green', roles: 'violet', channels: 'brand', moderation: 'red', voice: 'yellow', server: 'gray' };
const CATEGORY_LABEL: Record<string, string> = { messages: 'Nachrichten', members: 'Mitglieder', roles: 'Rollen', channels: 'Kanäle', moderation: 'Moderation', voice: 'Voice', server: 'Server' };

interface FeedItem {
  id: string;
  category: string;
  summary: string;
  at: string;
}

function eventToFeed(ev: LiveEvent): FeedItem | null {
  const at = new Date(ev.ts).toISOString();
  const id = `${ev.type}-${ev.ts}-${Math.random()}`;
  switch (ev.type) {
    case 'log':
      return { id: `log-${ev.data.id}`, category: ev.data.category, summary: ev.data.summary, at: ev.data.createdAt };
    case 'level.up':
      return { id, category: 'members', summary: `🎉 ${ev.data.username} hat Level ${ev.data.level} erreicht`, at };
    case 'automation.run':
      return { id, category: 'server', summary: `⚙️ Automatisierung „${ev.data.name}“ ausgeführt${ev.data.error ? ' (mit Fehler)' : ''}`, at };
    case 'economy.purchase':
      return { id, category: 'server', summary: `🛒 Kauf: ${ev.data.qty}× ${ev.data.item}`, at };
    default:
      return null;
  }
}

export default function DashboardPage() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const { data: guild } = useGuild();
  const { bot } = useLiveContext();
  const { channelName } = useLookup();
  const [days, setDays] = useState(30);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['overview', guildId, days],
    queryFn: () => api.get<Overview>(`/guilds/${guildId}/overview?days=${days}`),
    refetchInterval: 120_000,
  });
  const [feed, setFeed] = useState<FeedItem[]>([]);

  // Live-Aktualisierung der Kennzahlen und des Aktivitätsfeeds
  useLive(['stats.tick', 'member.join', 'member.leave', 'stats.snapshot', 'mod.case', 'ticket.created', 'ticket.updated'], (ev) => {
    qc.setQueryData<Overview>(['overview', guildId, days], (old) => {
      if (!old) return old;
      const t = { ...old.totals };
      if (ev.type === 'stats.tick') t.messagesToday += ev.data.messages ?? 0;
      if (ev.type === 'member.join') {
        t.members = ev.data.memberCount ?? t.members + 1;
        t.joins7d++;
      }
      if (ev.type === 'member.leave') {
        t.members = ev.data.memberCount ?? t.members - 1;
        t.leaves7d++;
      }
      if (ev.type === 'stats.snapshot') {
        t.members = ev.data.memberCount;
        t.online = ev.data.online;
      }
      if (ev.type === 'mod.case') t.modActions7d++;
      if (ev.type === 'ticket.created') t.openTickets++;
      if (ev.type === 'ticket.updated' && ev.data.status === 'CLOSED') t.openTickets = Math.max(0, t.openTickets - 1);
      return { ...old, totals: t };
    });
  });
  useLive(['log', 'level.up', 'automation.run', 'economy.purchase'], (ev) => {
    const item = eventToFeed(ev);
    if (item) setFeed((f) => [item, ...f].slice(0, 50));
  });

  const allFeed = useMemo(() => {
    const base = (data?.recentLogs ?? []).map((l) => ({ id: `log-${l.id}`, category: l.category, summary: l.summary, at: l.createdAt }));
    const seen = new Set<string>();
    return [...feed, ...base].filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true))).slice(0, 40);
  }, [feed, data?.recentLogs]);

  if (isLoading) return <LoadingBlock />;
  if (error || !data) return <ErrorState error={error} onRetry={() => refetch()} />;
  const t = data.totals;
  const growth = data.series.filter((s) => s.members !== null);
  const live = guild?.live;

  return (
    <>
      <PageHeader
        title="Dashboard"
        icon={Gauge}
        description={`Überblick über ${guild?.name ?? 'deinen Server'}`}
        actions={
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-40">
            <option value={7}>Letzte 7 Tage</option>
            <option value={30}>Letzte 30 Tage</option>
            <option value={90}>Letzte 90 Tage</option>
          </Select>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Mitglieder" value={num(t.members)} icon={Users} hint={`+${t.joins7d} / −${t.leaves7d} in 7 Tagen`} live />
        <StatCard label="Online" value={t.online === null ? '—' : num(t.online)} icon={Wifi} accent="green" hint={t.online !== null && t.members ? `${Math.round((t.online / t.members) * 100)}% der Mitglieder` : 'Wird alle 10 Min. erfasst'} delay={0.05} />
        <StatCard label="Nachrichten heute" value={num(t.messagesToday)} icon={MessageSquare} accent="violet" hint={`${compact(t.messages7d)} in 7 Tagen`} delay={0.1} live />
        <StatCard label="Moderation (7 T)" value={num(t.modActions7d)} icon={Gavel} accent="red" hint={`${t.openTickets} offene Tickets`} delay={0.15} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2" delay={0.1}>
          <CardHeader title="Serverwachstum" description="Mitgliederzahl pro Tag" icon={Users} />
          <div className="h-72 px-2 py-4">
            {growth.length < 2 ? (
              <EmptyState icon={Users} title="Noch zu wenig Daten" description="Die Mitgliederzahl wird alle 10 Minuten erfasst. Das Diagramm füllt sich in den nächsten Tagen." />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={growth} margin={{ left: 0, right: 12, top: 8 }}>
                  <GradientDefs id="gMembers" color={CHART.brand} />
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDay} {...axisProps} minTickGap={24} />
                  <YAxis {...axisProps} width={48} domain={['dataMin - 5', 'dataMax + 5']} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip labelFormatter={shortDay} />} />
                  <Area type="monotone" dataKey="members" name="Mitglieder" stroke={CHART.brand} strokeWidth={2.5} fill="url(#gMembers)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card delay={0.15}>
          <CardHeader title="Bot-Status" icon={Bot} actions={<Badge color={bot?.online ? 'green' : 'red'} dot>{bot?.online ? 'Online' : 'Offline'}</Badge>} />
          <div className="px-5 py-3">
            <div className="mb-3 flex items-center gap-3">
              <Avatar src={bot?.avatar} name={bot?.tag ?? 'Bot'} size={44} />
              <div>
                <div className="font-medium">{bot?.tag ?? 'Discord OS'}</div>
                <div className="text-xs text-fg-subtle">{bot?.online ? `Seit ${duration((bot.uptimeMs ?? 0) / 1000)} online` : 'Nicht verbunden'}</div>
              </div>
            </div>
            <KeyValue label="Gateway-Latenz" value={bot?.online ? <span className="flex items-center gap-1.5"><Radio className="h-3.5 w-3.5 text-emerald-400" />{bot.ping} ms</span> : '—'} />
            <KeyValue label="Server" value={num(bot?.guilds)} />
            <KeyValue label="Nutzer gesamt" value={compact(bot?.users)} />
            <KeyValue label="Arbeitsspeicher" value={bot?.memoryMb ? <span className="flex items-center gap-1.5"><Cpu className="h-3.5 w-3.5 text-fg-subtle" />{bot.memoryMb} MB</span> : '—'} />
            {live && live.botMissing.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">
                Fehlende Bot-Rechte auf diesem Server: {live.botMissing.join(', ')}
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2" delay={0.2}>
          <CardHeader title="Aktivitätsübersicht" description="Nachrichten, Beitritte und Austritte pro Tag" icon={Activity} />
          <div className="h-72 px-2 py-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.series} margin={{ left: 0, right: 12, top: 8 }}>
                <CartesianGrid stroke={CHART.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={shortDay} {...axisProps} minTickGap={20} />
                <YAxis yAxisId="m" {...axisProps} width={44} allowDecimals={false} />
                <YAxis yAxisId="j" orientation="right" {...axisProps} width={32} allowDecimals={false} />
                <Tooltip content={<ChartTooltip labelFormatter={shortDay} />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                <Bar yAxisId="m" dataKey="messages" name="Nachrichten" fill={CHART.violet} radius={[4, 4, 0, 0]} maxBarSize={18} />
                <Bar yAxisId="j" dataKey="joins" name="Beitritte" fill={CHART.green} radius={[4, 4, 0, 0]} maxBarSize={8} />
                <Bar yAxisId="j" dataKey="leaves" name="Austritte" fill={CHART.red} radius={[4, 4, 0, 0]} maxBarSize={8} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card delay={0.25}>
          <CardHeader title="Letzte 24 Stunden" description="Nachrichten pro Stunde" icon={MessageSquare} />
          <div className="h-72 px-2 py-4">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.hourly} margin={{ left: 0, right: 12, top: 8 }}>
                <GradientDefs id="gHour" color={CHART.blue} />
                <CartesianGrid stroke={CHART.grid} vertical={false} />
                <XAxis dataKey="hour" tickFormatter={(h) => new Date(h).getHours() + ' Uhr'} {...axisProps} minTickGap={28} />
                <YAxis {...axisProps} width={36} allowDecimals={false} />
                <Tooltip content={<ChartTooltip labelFormatter={(h) => new Date(h).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} />} />
                <Area type="monotone" dataKey="messages" name="Nachrichten" stroke={CHART.blue} strokeWidth={2} fill="url(#gHour)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2" delay={0.3}>
          <CardHeader title="Live-Aktivität" description="Ereignisse auf dem Server in Echtzeit" icon={Radio} actions={<span className="flex items-center gap-2 text-xs text-emerald-300"><span className="h-2 w-2 animate-pulse-soft rounded-full bg-emerald-400" />Live</span>} />
          <div className="max-h-[420px] overflow-y-auto">
            {allFeed.length === 0 ? (
              <EmptyState icon={Activity} title="Noch keine Aktivität" description="Sobald etwas passiert, erscheint es hier sofort. Für Protokolleinträge muss das Logging-Modul aktiv sein." />
            ) : (
              <ul>
                <AnimatePresence initial={false}>
                  {allFeed.map((f) => (
                    <motion.li key={f.id} initial={{ opacity: 0, backgroundColor: 'rgba(99,102,241,0.12)' }} animate={{ opacity: 1, backgroundColor: 'rgba(0,0,0,0)' }} transition={{ duration: 1.2 }} className="flex items-start gap-3 border-b border-line/50 px-5 py-3 last:border-0">
                      <Badge color={CATEGORY_COLOR[f.category] ?? 'gray'} className="mt-0.5">{CATEGORY_LABEL[f.category] ?? f.category}</Badge>
                      <span className="flex-1 text-sm leading-relaxed text-fg/90">{f.summary.replace(/<#(\d+)>/g, (_, id: string) => channelName(id)).replace(/<@!?(\d+)>/g, '@$1')}</span>
                      <span className="shrink-0 text-xs text-fg-subtle">{relative(f.at)}</span>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </div>
        </Card>

        <div className="space-y-4">
          <Card delay={0.35}>
            <CardHeader title="Aktivste Mitglieder" description="Letzte 7 Tage" icon={Users} />
            <div className="p-3">
              {data.topMembers.length === 0 ? (
                <p className="px-2 py-6 text-center text-sm text-fg-subtle">Noch keine Daten</p>
              ) : (
                data.topMembers.map((m, i) => (
                  <div key={m.userId} className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-panel-2">
                    <span className="w-5 text-center text-sm font-semibold text-fg-subtle">{i + 1}</span>
                    <Avatar src={avatarUrl(m.userId, m.avatar)} name={m.username} size={32} />
                    <span className="flex-1 truncate text-sm">{m.username}</span>
                    <span className="text-xs text-fg-muted tabular-nums">{num(m.messages)} Nachr.</span>
                  </div>
                ))
              )}
            </div>
          </Card>
          <Card delay={0.4}>
            <CardHeader title="Moderationsaktionen" description={`Letzte ${days} Tage`} icon={Gavel} />
            <div className="flex items-center gap-4 p-5">
              {data.modByType.length === 0 ? (
                <p className="w-full py-4 text-center text-sm text-fg-subtle">Keine Moderationsaktionen</p>
              ) : (
                <>
                  <div className="h-32 w-32 shrink-0">
                    <ResponsiveContainer>
                      <PieChart>
                        <Pie data={data.modByType} dataKey="count" nameKey="type" innerRadius={36} outerRadius={60} paddingAngle={3} stroke="none">
                          {data.modByType.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="flex-1 space-y-1.5 text-sm">
                    {data.modByType.map((m, i) => (
                      <li key={m.type} className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
                        <span className="flex-1 text-fg-muted">{CASE_LABEL[m.type] ?? m.type}</span>
                        <span className="font-medium tabular-nums">{m.count}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </Card>
        </div>
      </div>

      {live && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Kanäle" value={num(live.channelCount)} icon={Server} accent="blue" delay={0.45} />
          <StatCard label="Rollen" value={num(live.roleCount)} icon={Users} accent="violet" delay={0.5} />
          <StatCard label="Boosts" value={num(live.boosts)} icon={UserPlus} accent="yellow" hint={`Stufe ${live.boostTier}`} delay={0.55} />
          <StatCard label="Offene Tickets" value={num(t.openTickets)} icon={Ticket} accent="green" delay={0.6} hint={<span className="flex items-center gap-1"><UserMinus className="h-3 w-3" />{t.leaves7d} Austritte (7 T)</span>} />
        </div>
      )}
    </>
  );
}
