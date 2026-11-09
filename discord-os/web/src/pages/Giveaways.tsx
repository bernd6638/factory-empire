import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Archive,
  CalendarClock,
  CheckCircle2,
  Clock,
  Crown,
  Dices,
  Eye,
  Gift,
  Hourglass,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  Trophy,
  UserCheck,
  Users,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../lib/api';
import { useTick } from '../lib/tick';
import { useLive } from '../lib/live';
import { cn, dateTime, num, relative } from '../lib/format';
import type { Paged } from '../lib/types';
import { useCan, useGuildId, useLookup, useModuleConfig } from '../hooks/guild';
import { useLiveContext } from '../lib/live';
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, LoadingBlock, NumberInput, PageHeader, Pagination, StatCard, Switch, Tabs, Textarea } from '../components/ui/core';
import { Modal, useConfirm, useToast } from '../components/ui/overlay';
import { ActionMenu } from '../components/ui/menu';
import { ChannelSelect, MultiRoleSelect, RoleSelect } from '../components/ui/pickers';
import { ModuleToggle, SaveBar } from '../components/ui/module';
import { CHART, ChartTooltip, GradientDefs, axisProps } from '../components/ui/chart';

type Status = 'SCHEDULED' | 'ACTIVE' | 'PAUSED' | 'ENDED' | 'CANCELLED';

interface Profile {
  userId: string;
  username: string;
  avatarUrl: string;
}

interface Giveaway {
  id: number;
  channelId: string;
  messageId: string | null;
  prize: string;
  description: string | null;
  imageUrl: string | null;
  color: string;
  winnerCount: number;
  hostId: string;
  status: Status;
  startsAt: string;
  endsAt: string;
  pausedAt: string | null;
  requiredRoleIds: string[];
  blockedRoleIds: string[];
  minMemberDays: number;
  minAccountDays: number;
  requireVerified: boolean;
  maxEntries: number | null;
  reminderMinutes: number;
  seedHash: string;
  seed: string | null;
  winners: string[];
  rerolls: number;
  archived: boolean;
  endedAt: string | null;
  createdAt: string;
  entryCount: number;
  winnerProfiles: Profile[];
}

interface Detail extends Giveaway {
  reserveCount: number;
  timeline: { t: string; entries: number; total: number }[];
}

const STATUS: Record<Status, { label: string; color: 'green' | 'yellow' | 'blue' | 'gray' | 'red' }> = {
  ACTIVE: { label: 'Live', color: 'green' },
  PAUSED: { label: 'Pausiert', color: 'yellow' },
  SCHEDULED: { label: 'Geplant', color: 'blue' },
  ENDED: { label: 'Beendet', color: 'gray' },
  CANCELLED: { label: 'Abgebrochen', color: 'red' },
};

function countdownParts(to: string, now: number) {
  const diff = Math.max(0, new Date(to).getTime() - now) / 1000;
  return { d: Math.floor(diff / 86400), h: Math.floor((diff % 86400) / 3600), m: Math.floor((diff % 3600) / 60), s: Math.floor(diff % 60) };
}

function Countdown({ to }: { to: string }) {
  const now = useTick();
  const p = countdownParts(to, now);
  const cells = p.d ? [['T', p.d], ['Std', p.h], ['Min', p.m]] : [['Std', p.h], ['Min', p.m], ['Sek', p.s]];
  return (
    <div className="flex gap-1.5">
      {cells.map(([l, v]) => (
        <div key={l as string} className="min-w-[46px] rounded-lg border border-line bg-black/30 px-2 py-1.5 text-center">
          <div className="font-mono text-lg leading-none font-semibold tabular-nums">{String(v).padStart(2, '0')}</div>
          <div className="mt-0.5 text-[9px] tracking-wider text-fg-subtle uppercase">{l}</div>
        </div>
      ))}
    </div>
  );
}

function toLocalInput(d: Date) {
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

// ─────────────────────────── Editor ───────────────────────────

interface Draft {
  channelId: string | null;
  prize: string;
  description: string;
  imageUrl: string;
  color: string;
  winnerCount: number;
  startMode: 'now' | 'later';
  startsAt: string;
  endsAt: string;
  requiredRoleIds: string[];
  blockedRoleIds: string[];
  minMemberDays: number;
  minAccountDays: number;
  requireVerified: boolean;
  maxEntries: number | null;
  reminderMinutes: number;
}

const DURATIONS = [
  { label: '1 Std', min: 60 },
  { label: '1 Tag', min: 1440 },
  { label: '3 Tage', min: 4320 },
  { label: '1 Woche', min: 10080 },
  { label: '2 Wochen', min: 20160 },
];

function newDraft(): Draft {
  return {
    channelId: null,
    prize: '',
    description: '',
    imageUrl: '',
    color: '#8b5cf6',
    winnerCount: 1,
    startMode: 'now',
    startsAt: toLocalInput(new Date(Date.now() + 3_600_000)),
    endsAt: toLocalInput(new Date(Date.now() + 86_400_000)),
    requiredRoleIds: [],
    blockedRoleIds: [],
    minMemberDays: 0,
    minAccountDays: 0,
    requireVerified: false,
    maxEntries: null,
    reminderMinutes: 60,
  };
}

function PreviewEmbed({ d }: { d: Draft }) {
  const { bot } = useLiveContext();
  const { roleName } = useLookup();
  const reqs = [
    ...(d.requiredRoleIds.length ? [`• Rolle: ${d.requiredRoleIds.map((r) => `@${roleName(r)}`).join(' oder ')}`] : []),
    ...(d.minMemberDays ? [`• Mindestens ${d.minMemberDays} Tage auf dem Server`] : []),
    ...(d.minAccountDays ? [`• Discord-Konto älter als ${d.minAccountDays} Tage`] : []),
    ...(d.requireVerified ? ['• Verifiziertes Mitglied (Regeln akzeptiert)'] : []),
    ...(d.maxEntries ? [`• Max. ${d.maxEntries} Teilnehmer`] : []),
  ];
  return (
    <div className="rounded-xl bg-[#313338] p-4 font-[system-ui] text-[14px] text-[#dbdee1]">
      <div className="flex gap-3">
        <Avatar src={bot?.avatar} name={bot?.tag ?? 'Bot'} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-white">{bot?.tag?.split('#')[0] ?? 'Discord OS'}</span>
            <span className="rounded bg-[#5865f2] px-1 text-[10px] font-semibold text-white">APP</span>
          </div>
          <div className="mt-1 max-w-[440px] rounded border-l-4 bg-[#2b2d31] p-3" style={{ borderColor: d.color }}>
            <div className="font-semibold text-white">🎁 {d.prize || 'Dein Gewinn'}</div>
            {d.description && <div className="mt-1 whitespace-pre-wrap">{d.description}</div>}
            <div className="mt-2">⏳ Endet {d.endsAt ? new Date(d.endsAt).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '…'}</div>
            <div>👥 <b>0</b> Teilnehmer · 🏅 {d.winnerCount} Gewinner</div>
            {reqs.length > 0 && (
              <div className="mt-2">
                <div className="font-semibold text-white">Teilnahmebedingungen</div>
                {reqs.map((r) => <div key={r}>{r}</div>)}
              </div>
            )}
            {d.imageUrl && <img src={d.imageUrl} alt="" className="mt-3 max-h-48 rounded object-cover" />}
            <div className="mt-2 text-xs text-[#949ba4]">Gewinnspiel #… • Prüfsumme: a1b2c3…</div>
          </div>
          <div className="mt-2 inline-flex items-center gap-1.5 rounded bg-[#5865f2] px-4 py-1.5 text-sm font-medium text-white">🎉 Teilnehmen</div>
        </div>
      </div>
    </div>
  );
}

function Editor({ editing, onClose }: { editing: Giveaway | null; onClose: () => void }) {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState<Draft>(() =>
    editing
      ? {
          channelId: editing.channelId,
          prize: editing.prize,
          description: editing.description ?? '',
          imageUrl: editing.imageUrl ?? '',
          color: editing.color,
          winnerCount: editing.winnerCount,
          startMode: 'now',
          startsAt: toLocalInput(new Date(editing.startsAt)),
          endsAt: toLocalInput(new Date(editing.endsAt)),
          requiredRoleIds: editing.requiredRoleIds,
          blockedRoleIds: editing.blockedRoleIds,
          minMemberDays: editing.minMemberDays,
          minAccountDays: editing.minAccountDays,
          requireVerified: editing.requireVerified,
          maxEntries: editing.maxEntries,
          reminderMinutes: editing.reminderMinutes,
        }
      : newDraft(),
  );
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const start = d.startMode === 'later' ? new Date(d.startsAt) : new Date();

  const save = useMutation({
    mutationFn: () => {
      const common = {
        prize: d.prize,
        description: d.description || null,
        imageUrl: d.imageUrl || null,
        color: d.color,
        winnerCount: d.winnerCount,
        requiredRoleIds: d.requiredRoleIds,
        blockedRoleIds: d.blockedRoleIds,
        minMemberDays: d.minMemberDays,
        minAccountDays: d.minAccountDays,
        requireVerified: d.requireVerified,
        maxEntries: d.maxEntries,
        reminderMinutes: d.reminderMinutes,
      };
      if (editing) return api.patch(`/guilds/${guildId}/giveaways/${editing.id}`, common);
      return api.post(`/guilds/${guildId}/giveaways`, { ...common, channelId: d.channelId, startsAt: d.startMode === 'later' ? new Date(d.startsAt).toISOString() : undefined, endsAt: new Date(d.endsAt).toISOString() });
    },
    onSuccess: () => {
      toast.success(editing ? 'Gewinnspiel aktualisiert' : d.startMode === 'later' ? 'Gewinnspiel geplant' : 'Gewinnspiel veröffentlicht 🎉');
      void qc.invalidateQueries({ queryKey: ['giveaways'] });
      onClose();
    },
    onError: toast.error,
  });
  const valid = d.prize.trim() && (editing || d.channelId) && new Date(d.endsAt).getTime() > start.getTime() + 60_000;

  return (
    <Modal open onClose={onClose} size="xl" title={editing ? `Gewinnspiel #${editing.id} bearbeiten` : 'Neues Gewinnspiel'} description="Teilnahme per Button · faire, nachprüfbare Ziehung" footer={<><Button variant="ghost" onClick={onClose}>Abbrechen</Button><Button variant="primary" icon={editing ? CheckCircle2 : d.startMode === 'later' ? CalendarClock : Gift} disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>{editing ? 'Speichern' : d.startMode === 'later' ? 'Planen' : 'Veröffentlichen'}</Button></>}>
      <div className="grid gap-6 lg:grid-cols-[1.15fr_1fr]">
        <div className="space-y-5">
          <section className="space-y-4">
            <div className="label">Gewinn</div>
            {!editing && <Field label="Kanal"><ChannelSelect value={d.channelId} onChange={(v) => set({ channelId: v })} /></Field>}
            <Field label="Preis"><Input value={d.prize} maxLength={200} placeholder="z. B. Discord Nitro (1 Monat)" onChange={(e) => set({ prize: e.target.value })} /></Field>
            <Field label="Beschreibung"><Textarea value={d.description} maxLength={2000} className="min-h-[80px]" onChange={(e) => set({ description: e.target.value })} /></Field>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
              <Field label="Bild-URL" hint="Direktlink .png/.jpg/.gif"><Input value={d.imageUrl} placeholder="https://…" onChange={(e) => set({ imageUrl: e.target.value })} /></Field>
              <Field label="Farbe"><input type="color" value={d.color} onChange={(e) => set({ color: e.target.value })} className="h-10 w-12 cursor-pointer rounded-lg border border-line bg-panel-2" /></Field>
              <Field label="Gewinner"><NumberInput value={d.winnerCount} min={1} max={50} className="w-24" onChange={(v) => set({ winnerCount: v })} /></Field>
            </div>
          </section>

          <section className="space-y-3 rounded-xl border border-line bg-white/[0.015] p-4">
            <div className="label">Zeitraum</div>
            {!editing && (
              <div className="flex gap-2">
                {(['now', 'later'] as const).map((m) => (
                  <button key={m} onClick={() => set({ startMode: m })} className={cn('flex-1 rounded-xl border px-3 py-2 text-sm transition', d.startMode === m ? 'border-brand-500/50 bg-brand-500/10 text-fg' : 'border-line text-fg-muted hover:text-fg')}>
                    {m === 'now' ? 'Sofort starten' : 'Später starten'}
                  </button>
                ))}
              </div>
            )}
            {!editing && d.startMode === 'later' && <Field label="Start"><Input type="datetime-local" value={d.startsAt} onChange={(e) => set({ startsAt: e.target.value })} /></Field>}
            {!editing && (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {DURATIONS.map((x) => (
                    <button key={x.min} onClick={() => set({ endsAt: toLocalInput(new Date(start.getTime() + x.min * 60_000)) })} className="rounded-lg border border-line px-2.5 py-1 text-xs text-fg-muted transition hover:border-brand-500/40 hover:text-fg">
                      {x.label}
                    </button>
                  ))}
                </div>
                <Field label="Ende"><Input type="datetime-local" value={d.endsAt} onChange={(e) => set({ endsAt: e.target.value })} /></Field>
              </>
            )}
            {editing && <p className="text-sm text-fg-muted">Endet {dateTime(editing.endsAt)} – zum Verlängern das Menü der Karte verwenden.</p>}
            <Field label="Erinnerung vor Ende" hint="0 = keine Erinnerung im Kanal"><NumberInput value={d.reminderMinutes} min={0} max={10080} suffix="Min." onChange={(v) => set({ reminderMinutes: v })} /></Field>
          </section>

          <section className="space-y-3 rounded-xl border border-line bg-white/[0.015] p-4">
            <div className="label">Teilnahmebedingungen</div>
            <Field label="Benötigte Rolle (eine davon)"><MultiRoleSelect value={d.requiredRoleIds} onChange={(v) => set({ requiredRoleIds: v })} placeholder="Alle dürfen teilnehmen" /></Field>
            <Field label="Ausgeschlossene Rollen"><MultiRoleSelect value={d.blockedRoleIds} onChange={(v) => set({ blockedRoleIds: v })} placeholder="Keine" /></Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Min. Tage auf Server"><NumberInput value={d.minMemberDays} min={0} max={3650} onChange={(v) => set({ minMemberDays: v })} /></Field>
              <Field label="Min. Kontoalter (Tage)"><NumberInput value={d.minAccountDays} min={0} max={3650} onChange={(v) => set({ minAccountDays: v })} /></Field>
              <Field label="Max. Teilnehmer"><Input type="number" min={1} value={d.maxEntries ?? ''} placeholder="∞" onChange={(e) => set({ maxEntries: e.target.value ? Number(e.target.value) : null })} /></Field>
            </div>
            <Switch label="Nur verifizierte Mitglieder" description="Mitglied hat die Serverregeln (Membership Screening) akzeptiert" checked={d.requireVerified} onChange={(v) => set({ requireVerified: v })} />
          </section>
        </div>
        <div className="space-y-3 lg:sticky lg:top-0 lg:self-start">
          <div className="label">Live-Vorschau</div>
          <PreviewEmbed d={d} />
          <div className="flex items-start gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-200/90">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            Manipulationsschutz: Beim Erstellen wird ein geheimer Zufallswert festgelegt und nur seine Prüfsumme veröffentlicht. Nach dem Ende wird er offengelegt – jeder kann die Ziehung nachrechnen.
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────── Detail ───────────────────────────

function DetailModal({ id, onClose }: { id: number; onClose: () => void }) {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [showProof, setShowProof] = useState(false);
  const detail = useQuery({ queryKey: ['giveaways', 'detail', guildId, id], queryFn: () => api.get<Detail>(`/guilds/${guildId}/giveaways/${id}`) });
  const entries = useQuery({
    queryKey: ['giveaways', 'entries', guildId, id, page],
    queryFn: () => api.get<Paged<Profile & { createdAt: string; winner: boolean }>>(`/guilds/${guildId}/giveaways/${id}/entries?page=${page}&limit=50`),
    placeholderData: (p) => p,
  });
  const proof = useQuery({
    queryKey: ['giveaways', 'proof', guildId, id],
    queryFn: () => api.get<{ seed: string; seedHash: string; hashMatches: boolean; method: string; order: { position: number; userId: string; ticket: string; winner: boolean }[] }>(`/guilds/${guildId}/giveaways/${id}/verify`),
    enabled: showProof,
  });
  const reroll = useMutation({
    mutationFn: (replaceUserId?: string) => api.post(`/guilds/${guildId}/giveaways/${id}/reroll`, { count: 1, replaceUserId: replaceUserId ?? null }),
    onSuccess: () => (toast.success('Ersatzgewinner gezogen'), void qc.invalidateQueries({ queryKey: ['giveaways'] })),
    onError: toast.error,
  });
  useLive(['giveaway.entry', 'giveaway.updated'], (ev) => {
    if (ev.data.id === id) {
      void qc.invalidateQueries({ queryKey: ['giveaways', 'detail', guildId, id] });
      void qc.invalidateQueries({ queryKey: ['giveaways', 'entries', guildId, id] });
    }
  });
  const g = detail.data;
  const list = (entries.data?.items ?? []).filter((e) => !q || e.username.toLowerCase().includes(q.toLowerCase()) || e.userId.includes(q));

  return (
    <Modal open onClose={onClose} size="xl" title={g ? `🎁 ${g.prize}` : 'Gewinnspiel'} description={g ? `#${g.id} · ${STATUS[g.status].label} · Ende ${dateTime(g.endsAt)}` : undefined}>
      {detail.isLoading || !g ? (
        <LoadingBlock compact />
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              { l: 'Teilnehmer', v: num(g.entryCount), i: Users },
              { l: 'Gewinner', v: `${g.winners.length}/${g.winnerCount}`, i: Trophy },
              { l: 'Ersatz verfügbar', v: g.status === 'ENDED' ? num(g.reserveCount) : '—', i: Dices },
              { l: 'Neu gezogen', v: num(g.rerolls), i: Hourglass },
            ].map((s) => (
              <div key={s.l} className="rounded-xl border border-line bg-white/[0.015] p-3.5">
                <div className="flex items-center gap-1.5 text-[11px] tracking-wider text-fg-subtle uppercase"><s.i className="h-3.5 w-3.5" />{s.l}</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">{s.v}</div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-line p-4">
            <div className="mb-2 text-sm font-medium">Teilnahmeverlauf</div>
            <div className="h-48">
              {g.timeline.length < 1 ? (
                <div className="flex h-full items-center justify-center text-sm text-fg-subtle">Noch keine Teilnahmen</div>
              ) : (
                <ResponsiveContainer>
                  <AreaChart data={g.timeline}>
                    <GradientDefs id="gGw" color={CHART.violet} />
                    <CartesianGrid stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="t" tickFormatter={(t) => new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit' })} {...axisProps} minTickGap={30} />
                    <YAxis {...axisProps} width={36} allowDecimals={false} />
                    <Tooltip content={<ChartTooltip labelFormatter={(t) => new Date(t).toLocaleString('de-DE')} />} />
                    <Area type="stepAfter" dataKey="total" name="Teilnehmer gesamt" stroke={CHART.violet} strokeWidth={2} fill="url(#gGw)" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {g.status === 'ENDED' && (
            <div className="rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 to-transparent p-4">
              <div className="mb-3 flex items-center gap-2 font-medium"><Crown className="h-4 w-4 text-amber-300" /> Gewinner</div>
              {g.winnerProfiles.length === 0 ? (
                <p className="text-sm text-fg-muted">Keine gültigen Teilnehmer.</p>
              ) : (
                <div className="space-y-2">
                  {g.winnerProfiles.map((w) => (
                    <div key={w.userId} className="flex items-center gap-3">
                      <Avatar src={w.avatarUrl} name={w.username} size={30} />
                      <span className="flex-1 text-sm font-medium">{w.username}</span>
                      <Button size="sm" variant="ghost" icon={Dices} loading={reroll.isPending} disabled={!g.reserveCount} onClick={() => reroll.mutate(w.userId)}>Ersetzen</Button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3 flex gap-2">
                <Button size="sm" icon={Plus} disabled={!g.reserveCount} loading={reroll.isPending} onClick={() => reroll.mutate(undefined)}>Zusätzlichen Gewinner ziehen</Button>
                <Button size="sm" variant="ghost" icon={ShieldCheck} onClick={() => setShowProof((s) => !s)}>{showProof ? 'Nachweis ausblenden' : 'Fairness-Nachweis'}</Button>
              </div>
              {showProof && proof.data && (
                <div className="mt-4 space-y-2 rounded-lg border border-line bg-black/30 p-3 text-xs">
                  <div className="flex items-center gap-2">{proof.data.hashMatches ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-red-400" />} sha256(Seed) {proof.data.hashMatches ? 'stimmt mit der veröffentlichten Prüfsumme überein' : 'stimmt NICHT überein'}</div>
                  <div className="break-all"><span className="text-fg-subtle">Seed: </span><code>{proof.data.seed}</code></div>
                  <div className="break-all"><span className="text-fg-subtle">Prüfsumme: </span><code>{proof.data.seedHash}</code></div>
                  <div className="text-fg-subtle">{proof.data.method}</div>
                  <div className="max-h-40 overflow-y-auto">
                    {proof.data.order.slice(0, 25).map((o) => (
                      <div key={o.userId} className={cn('flex gap-2 font-mono', o.winner && 'text-amber-300')}>
                        <span className="w-6 text-right">{o.position}.</span>
                        <span>{o.userId}</span>
                        <span className="truncate text-fg-subtle">{o.ticket.slice(0, 16)}…</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="rounded-xl border border-line">
            <div className="flex items-center gap-3 border-b border-line px-4 py-3">
              <span className="flex items-center gap-2 text-sm font-medium"><Users className="h-4 w-4" /> Teilnehmer</span>
              {g.status === 'ACTIVE' && <span className="flex items-center gap-1.5 text-xs text-emerald-300"><span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-emerald-400" />live</span>}
              <div className="relative ml-auto w-52">
                <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
                <Input className="h-8 pl-8 text-xs" placeholder="Suchen …" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {list.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-fg-subtle">Keine Teilnehmer</p>
              ) : (
                list.map((e) => (
                  <div key={e.userId} className="flex items-center gap-3 border-b border-line/50 px-4 py-2 last:border-0">
                    <Avatar src={e.avatarUrl} name={e.username} size={26} />
                    <span className="flex-1 truncate text-sm">{e.username}</span>
                    {e.winner && <Badge color="yellow"><Crown className="h-3 w-3" />Gewinner</Badge>}
                    <span className="text-xs text-fg-subtle">{relative(e.createdAt)}</span>
                  </div>
                ))
              )}
            </div>
            {entries.data && <Pagination page={entries.data.page} total={entries.data.total} limit={entries.data.limit} onChange={setPage} />}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─────────────────────────── Karte ───────────────────────────

/** Zeitfortschritt eines Gewinnspiels (eigene Komponente, damit nur sie im Sekundentakt neu zeichnet). */
function TimeProgress({ g }: { g: Giveaway }) {
  const now = useTick();
  const total = new Date(g.endsAt).getTime() - new Date(g.startsAt).getTime();
  const elapsed = Math.min(1, Math.max(0, (now - new Date(g.startsAt).getTime()) / total));
  return (
    <div className="h-1 overflow-hidden rounded-full bg-white/5">
      <div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500" style={{ width: `${elapsed * 100}%` }} />
    </div>
  );
}

function GiveawayCard({ g, onOpen, onEdit, onExtend, index }: { g: Giveaway; onOpen: () => void; onEdit: () => void; onExtend: () => void; index: number }) {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const isAdmin = useCan('ADMIN');
  const act = useMutation({
    mutationFn: ({ path, method = 'post' }: { path: string; method?: 'post' | 'del' }) => (method === 'del' ? api.del(`/guilds/${guildId}/giveaways/${g.id}`) : api.post(`/guilds/${guildId}/giveaways/${g.id}/${path}`)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['giveaways'] }),
    onError: toast.error,
  });
  const live = g.status === 'ACTIVE';

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04 }} className="card card-hover group cursor-pointer overflow-hidden" onClick={onOpen}>
      <div className="relative h-28 overflow-hidden">
        {g.imageUrl ? (
          <img src={g.imageUrl} alt="" className="h-full w-full object-cover opacity-70 transition duration-500 group-hover:scale-105 group-hover:opacity-90" />
        ) : (
          <div className="h-full w-full" style={{ background: `radial-gradient(120% 140% at 0% 0%, ${g.color}66, transparent 60%), radial-gradient(100% 120% at 100% 100%, #5865ff40, transparent 60%), #0d0f14` }}>
            <Gift className="absolute right-5 bottom-3 h-16 w-16 text-white/10 transition group-hover:rotate-6" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-panel via-panel/30 to-transparent" />
        <div className="absolute top-3 left-3 flex gap-1.5">
          <Badge color={STATUS[g.status].color} dot={live}>{STATUS[g.status].label}</Badge>
          {g.archived && <Badge>Archiv</Badge>}
        </div>
        <div className="absolute top-2 right-2">
          <ActionMenu
            items={[
              { label: 'Details & Teilnehmer', icon: Eye, onClick: onOpen },
              { label: 'Bearbeiten', icon: Pencil, onClick: onEdit, hidden: g.status === 'ENDED' || g.status === 'CANCELLED' },
              { label: 'Verlängern', icon: Clock, onClick: onExtend, hidden: !['ACTIVE', 'PAUSED', 'SCHEDULED'].includes(g.status) },
              { label: 'Pausieren', icon: Pause, onClick: () => act.mutate({ path: 'pause' }), hidden: g.status !== 'ACTIVE' },
              { label: 'Fortsetzen', icon: Play, onClick: () => act.mutate({ path: 'resume' }), hidden: g.status !== 'PAUSED' },
              { label: 'Jetzt beenden & ziehen', icon: Square, onClick: async () => (await confirm({ title: 'Gewinnspiel jetzt beenden?', message: 'Die Gewinner werden sofort gezogen und verkündet.', confirmLabel: 'Beenden' })) && act.mutate({ path: 'end' }), hidden: !['ACTIVE', 'PAUSED'].includes(g.status) },
              { label: 'Ersatzgewinner ziehen', icon: Dices, onClick: () => act.mutate({ path: 'reroll' }), hidden: g.status !== 'ENDED' },
              { label: g.archived ? 'Aus Archiv holen' : 'Archivieren', icon: Archive, onClick: () => act.mutate({ path: 'archive' }), hidden: g.status !== 'ENDED' && g.status !== 'CANCELLED' },
              { label: 'Abbrechen', icon: XCircle, danger: true, onClick: async () => (await confirm({ title: 'Gewinnspiel abbrechen?', message: 'Es werden keine Gewinner gezogen.', danger: true, confirmLabel: 'Abbrechen' })) && act.mutate({ path: 'cancel' }), hidden: g.status === 'ENDED' || g.status === 'CANCELLED' },
              { label: 'Löschen', icon: Trash2, danger: true, onClick: async () => (await confirm({ title: 'Endgültig löschen?', message: 'Gewinnspiel und Teilnahmen werden entfernt.', danger: true, confirmLabel: 'Löschen' })) && act.mutate({ path: '', method: 'del' }), hidden: !isAdmin || ['ACTIVE', 'PAUSED'].includes(g.status) },
            ]}
          />
        </div>
      </div>
      <div className="space-y-4 p-5 pt-2">
        <div>
          <h3 className="truncate text-lg font-semibold">{g.prize}</h3>
          <div className="mt-0.5 flex items-center gap-3 text-xs text-fg-muted">
            <span className="flex items-center gap-1"><Trophy className="h-3.5 w-3.5" />{g.winnerCount} Gewinner</span>
            <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" /><span className="font-semibold text-fg tabular-nums">{num(g.entryCount)}</span> Teilnehmer</span>
            {(g.requiredRoleIds.length > 0 || g.minMemberDays > 0 || g.requireVerified) && <span className="flex items-center gap-1"><UserCheck className="h-3.5 w-3.5" />Bedingungen</span>}
          </div>
        </div>
        {live && <Countdown to={g.endsAt} />}
        {g.status === 'SCHEDULED' && <div className="text-sm text-electric-400">Start {dateTime(g.startsAt)}</div>}
        {g.status === 'PAUSED' && <div className="text-sm text-amber-300">Pausiert seit {relative(g.pausedAt)}</div>}
        {g.status === 'ENDED' && (
          <div className="flex items-center gap-2">
            <div className="flex -space-x-2">
              {g.winnerProfiles.slice(0, 5).map((w) => <Avatar key={w.userId} src={w.avatarUrl} name={w.username} size={28} className="ring-2 ring-panel" />)}
            </div>
            <span className="truncate text-sm text-fg-muted">{g.winnerProfiles.length ? g.winnerProfiles.map((w) => w.username).join(', ') : 'Kein Gewinner'}</span>
          </div>
        )}
        {(live || g.status === 'PAUSED') && <TimeProgress g={g} />}
      </div>
    </motion.div>
  );
}

function ExtendModal({ g, onClose }: { g: Giveaway; onClose: () => void }) {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const [minutes, setMinutes] = useState(60);
  const save = useMutation({
    mutationFn: () => api.post(`/guilds/${guildId}/giveaways/${g.id}/extend`, { minutes }),
    onSuccess: () => (toast.success('Gewinnspiel verlängert'), void qc.invalidateQueries({ queryKey: ['giveaways'] }), onClose()),
    onError: toast.error,
  });
  return (
    <Modal open onClose={onClose} size="sm" title="Gewinnspiel verlängern" description={`Aktuelles Ende: ${dateTime(g.endsAt)}`} footer={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Verlängern</Button>}>
      <div className="mb-3 flex flex-wrap gap-2">
        {[30, 60, 360, 1440, 4320].map((m) => (
          <button key={m} onClick={() => setMinutes(m)} className={cn('rounded-lg border px-3 py-1.5 text-sm', minutes === m ? 'border-brand-500/50 bg-brand-500/10' : 'border-line text-fg-muted')}>
            {m < 60 ? `${m} Min` : m < 1440 ? `${m / 60} Std` : `${m / 1440} T`}
          </button>
        ))}
      </div>
      <Field label="Minuten"><NumberInput value={minutes} min={1} max={43200} onChange={setMinutes} /></Field>
      <p className="mt-2 text-xs text-fg-subtle">Neues Ende: {dateTime(new Date(new Date(g.endsAt).getTime() + minutes * 60_000))}</p>
    </Modal>
  );
}

function SettingsTab() {
  const m = useModuleConfig('giveaways');
  if (m.isLoading || !m.config) return <LoadingBlock compact />;
  const c = m.config;
  return (
    <div className="space-y-4">
      <ModuleToggle name="Giveaways" enabled={m.enabled} onChange={m.setEnabled} saving={m.saving} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Darstellung" icon={Gift} />
          <div className="grid gap-4 p-5 sm:grid-cols-[1fr_120px]">
            <Field label="Button-Text"><Input value={c.buttonLabel} maxLength={40} onChange={(e) => m.update((d) => void (d.buttonLabel = e.target.value))} /></Field>
            <Field label="Button-Emoji"><Input value={c.buttonEmoji} maxLength={32} onChange={(e) => m.update((d) => void (d.buttonEmoji = e.target.value))} /></Field>
            <Field label="Rolle beim Start pingen" className="sm:col-span-2"><RoleSelect value={c.pingRoleId} onChange={(v) => m.update((d) => void (d.pingRoleId = v))} placeholder="Niemanden pingen" /></Field>
            <div className="sm:col-span-2"><Switch label="Gewinner per DM benachrichtigen" checked={c.dmWinners} onChange={(v) => m.update((d) => void (d.dmWinners = v))} /></div>
          </div>
        </Card>
        <Card>
          <CardHeader title="Nachrichten" icon={Settings2} />
          <div className="space-y-4 p-5">
            <Field label="Gewinner-Bekanntgabe" hint="{winners} {prize}"><Textarea value={c.announceTemplate} maxLength={1000} onChange={(e) => m.update((d) => void (d.announceTemplate = e.target.value))} /></Field>
            <Field label="Erinnerung vor Ende" hint="{time} {prize}"><Textarea value={c.reminderTemplate} maxLength={500} onChange={(e) => m.update((d) => void (d.reminderTemplate = e.target.value))} /></Field>
          </div>
        </Card>
      </div>
      <SaveBar dirty={m.dirty} saving={m.saving} onSave={m.save} onReset={m.reset} />
    </div>
  );
}

type View = 'active' | 'scheduled' | 'ended' | 'archived' | 'settings';

export default function GiveawaysPage() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>('active');
  const [editing, setEditing] = useState<Giveaway | null | undefined>(params.get('new') ? null : undefined);
  const [extending, setExtending] = useState<Giveaway | null>(null);
  const openId = params.get('open');

  useEffect(() => {
    if (params.get('new')) {
      setEditing(null);
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const list = useQuery({ queryKey: ['giveaways', 'list', guildId, view], queryFn: () => api.get<Giveaway[]>(`/guilds/${guildId}/giveaways?view=${view}`), enabled: view !== 'settings' });
  const stats = useQuery({ queryKey: ['giveaways', 'stats', guildId], queryFn: () => api.get<{ total: number; active: number; scheduled: number; totalEntries: number; uniqueParticipants: number; avgEntries: number; topParticipants: (Profile & { entries: number })[] }>(`/guilds/${guildId}/giveaways/stats`) });

  // Live: Teilnehmerzahlen ohne Neuladen hochzählen, Statuswechsel neu laden
  useLive('giveaway.entry', (ev) => {
    qc.setQueryData<Giveaway[]>(['giveaways', 'list', guildId, view], (old) => old?.map((g) => (g.id === ev.data.id ? { ...g, entryCount: Math.max(0, g.entryCount + (ev.data.joined ? 1 : -1)) } : g)));
  });
  useLive('giveaway.updated', () => void qc.invalidateQueries({ queryKey: ['giveaways'] }));

  const sorted = list.data ?? [];

  return (
    <>
      <PageHeader
        title="Giveaways"
        description="Gewinnspiele erstellen, live verfolgen und fair auslosen"
        icon={Gift}
        actions={<Button variant="primary" icon={Plus} onClick={() => setEditing(null)}>Gewinnspiel erstellen</Button>}
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Laufend" value={num(stats.data?.active)} icon={Gift} accent="violet" live hint={`${num(stats.data?.scheduled)} geplant`} />
        <StatCard label="Teilnahmen gesamt" value={num(stats.data?.totalEntries)} icon={Users} delay={0.04} hint={`Ø ${num(stats.data?.avgEntries)} pro Gewinnspiel`} />
        <StatCard label="Einzigartige Teilnehmer" value={num(stats.data?.uniqueParticipants)} icon={UserCheck} accent="blue" delay={0.08} />
        <StatCard label="Gewinnspiele gesamt" value={num(stats.data?.total)} icon={Trophy} accent="yellow" delay={0.12} hint={stats.data?.topParticipants[0] ? `Top: ${stats.data.topParticipants[0].username} (${stats.data.topParticipants[0].entries}×)` : undefined} />
      </div>
      <Tabs
        value={view}
        onChange={setView}
        tabs={[
          { id: 'active', label: 'Aktiv', icon: Gift },
          { id: 'scheduled', label: 'Geplant', icon: CalendarClock },
          { id: 'ended', label: 'Beendet', icon: Trophy },
          { id: 'archived', label: 'Archiv', icon: Archive },
          { id: 'settings', label: 'Einstellungen', icon: Settings2 },
        ]}
      />
      {view === 'settings' ? (
        <SettingsTab />
      ) : list.isLoading ? (
        <LoadingBlock />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : sorted.length === 0 ? (
        <Card>
          <EmptyState
            icon={Gift}
            title={{ active: 'Keine laufenden Gewinnspiele', scheduled: 'Nichts geplant', ended: 'Noch keine beendeten Gewinnspiele', archived: 'Archiv ist leer' }[view]}
            description="Erstelle ein Gewinnspiel – Mitglieder nehmen per Button teil, die Ziehung erfolgt automatisch und nachprüfbar."
            action={view !== 'archived' && <Button variant="primary" icon={Plus} onClick={() => setEditing(null)}>Gewinnspiel erstellen</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {sorted.map((g, i) => (
            <GiveawayCard key={g.id} g={g} index={i} onOpen={() => setParams({ open: String(g.id) })} onEdit={() => setEditing(g)} onExtend={() => setExtending(g)} />
          ))}
        </div>
      )}
      {editing !== undefined && <Editor editing={editing} onClose={() => setEditing(undefined)} />}
      {extending && <ExtendModal g={extending} onClose={() => setExtending(null)} />}
      {openId && <DetailModal id={Number(openId)} onClose={() => setParams({})} />}
    </>
  );
}
