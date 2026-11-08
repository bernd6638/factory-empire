import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Clock, Coins, Gavel, MessageSquare, Mic, Search, Shield, Sparkles, Ticket, Trash2, TrendingUp, UserX, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, qs } from '../lib/api';
import { date, dateTime, duration, num, relative, shortDay } from '../lib/format';
import type { ModCase } from '../lib/types';
import { useCan, useGuildId, useLookup, useRoles } from '../hooks/guild';
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, KeyValue, LoadingBlock, NumberInput, PageHeader, Select, Tabs } from '../components/ui/core';
import { Modal, useToast } from '../components/ui/overlay';
import { RoleSelect } from '../components/ui/pickers';
import { CHART, ChartTooltip, GradientDefs, axisProps } from '../components/ui/chart';
import { CASE_COLOR, CASE_LABEL, ModActionModal } from '../components/shared/ModActionModal';

interface MemberRow {
  id: string;
  username: string;
  displayName: string;
  avatar: string;
  bot: boolean;
  joinedAt: string | null;
  roles: string[];
  timedOutUntil: string | null;
  xp: number;
  level: number;
  messages: number;
  lastMessageAt: string | null;
  warnings: number;
}

interface MemberDetail {
  live: (MemberRow & { inGuild: boolean; banned: boolean; createdAt: string; manageable?: boolean }) | null;
  profile: { xp: number; level: number; messages: number; voiceMinutes: number; rank: number | null; progress: { level: number; current: number; needed: number; percent: number }; lastMessageAt: string | null; joinedAt: string | null } | null;
  cases: ModCase[];
  series: { date: string; messages: number; xp: number; voiceMinutes: number }[];
  week: { messages: number; xp: number; voiceMinutes: number };
  month: { messages: number; xp: number; voiceMinutes: number };
  account: { wallet: number; bank: number; totalEarned: number; job: { name: string } | null; company: { name: string } | null } | null;
  inventory: { quantity: number; item: { name: string; emoji: string | null } }[];
  tickets: number;
}

function RoleChip({ id, onRemove }: { id: string; onRemove?: () => void }) {
  const { role } = useLookup();
  const r = role(id);
  if (!r) return null;
  const color = r.color !== '#000000' ? r.color : '#9aa1b2';
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-panel-2 py-0.5 pr-1 pl-2 text-xs">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {r.name}
      {onRemove && r.editable && (
        <button onClick={onRemove} className="rounded-full p-0.5 text-fg-subtle hover:bg-panel-3 hover:text-red-300" title="Rolle entfernen">
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

function MemberProfile({ userId, onClose }: { userId: string; onClose: () => void }) {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const canMod = useCan('MODERATOR');
  const canAdmin = useCan('ADMIN');
  const [modOpen, setModOpen] = useState(false);
  const [addRole, setAddRole] = useState<string | null>(null);
  const [xpOpen, setXpOpen] = useState(false);
  const [xpLevel, setXpLevel] = useState(0);
  const { data, isLoading, error } = useQuery({ queryKey: ['member', guildId, userId], queryFn: () => api.get<MemberDetail>(`/guilds/${guildId}/members/${userId}`) });

  const roles = useMutation({
    mutationFn: (body: { add?: string[]; remove?: string[] }) => api.put(`/guilds/${guildId}/members/${userId}/roles`, body),
    onSuccess: () => {
      toast.success('Rollen aktualisiert');
      void qc.invalidateQueries({ queryKey: ['member', guildId, userId] });
      void qc.invalidateQueries({ queryKey: ['members'] });
      setAddRole(null);
    },
    onError: toast.error,
  });
  const setXp = useMutation({
    mutationFn: () => api.post(`/guilds/${guildId}/members/${userId}/xp`, { level: xpLevel }),
    onSuccess: () => {
      toast.success('Level gesetzt');
      setXpOpen(false);
      void qc.invalidateQueries({ queryKey: ['member', guildId, userId] });
    },
    onError: toast.error,
  });

  const m = data?.live;
  return (
    <Modal open onClose={onClose} size="xl" title="Benutzerprofil">
      {isLoading ? (
        <LoadingBlock />
      ) : error ? (
        <ErrorState error={error} />
      ) : !data || !m ? (
        <EmptyState icon={UserX} title="Benutzer nicht gefunden" />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-line bg-gradient-to-r from-brand-500/10 via-accent-500/5 to-transparent p-5">
            <Avatar src={m.avatar} name={m.username} size={72} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-xl font-semibold">{m.displayName}</h3>
                {m.bot && <Badge color="blue"><Bot className="h-3 w-3" /> Bot</Badge>}
                {!m.inGuild && <Badge color="gray">Nicht auf dem Server</Badge>}
                {m.banned && <Badge color="red">Gebannt</Badge>}
                {m.timedOutUntil && <Badge color="yellow">Timeout bis {dateTime(m.timedOutUntil)}</Badge>}
              </div>
              <div className="mt-1 text-sm text-fg-muted">
                @{m.username} · <code className="text-xs">{m.id}</code>
              </div>
              <div className="mt-1 text-xs text-fg-subtle">
                Konto erstellt {date(m.createdAt)} {m.joinedAt && `· Beigetreten ${date(m.joinedAt)}`}
              </div>
            </div>
            {canMod && (
              <Button variant="danger" icon={Gavel} onClick={() => setModOpen(true)}>
                Moderieren
              </Button>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { icon: TrendingUp, label: 'Level', value: data.profile ? `${data.profile.level}` : '0', hint: data.profile?.rank ? `Rang #${data.profile.rank}` : '' },
              { icon: MessageSquare, label: 'Nachrichten', value: num(data.profile?.messages ?? 0), hint: `${num(data.week.messages)} diese Woche` },
              { icon: Mic, label: 'Voice', value: duration((data.profile?.voiceMinutes ?? 0) * 60), hint: `${num(data.month.voiceMinutes)} Min. (30 T)` },
              { icon: Gavel, label: 'Fälle', value: num(data.cases.length), hint: `${data.cases.filter((c) => c.type === 'WARN' && c.active).length} aktive Verwarnungen` },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-line bg-panel-2/50 p-4">
                <div className="flex items-center gap-2 text-xs text-fg-muted uppercase"><s.icon className="h-3.5 w-3.5" />{s.label}</div>
                <div className="mt-1.5 text-2xl font-semibold">{s.value}</div>
                <div className="text-xs text-fg-subtle">{s.hint}</div>
              </div>
            ))}
          </div>

          {data.profile && (
            <div className="rounded-xl border border-line bg-panel-2/40 p-4">
              <div className="mb-2 flex justify-between text-sm">
                <span>Fortschritt zu Level {data.profile.level + 1}</span>
                <span className="text-fg-muted">{num(data.profile.progress.current)} / {num(data.profile.progress.needed)} XP</span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-panel-3">
                <div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500" style={{ width: `${data.profile.progress.percent}%` }} />
              </div>
              {canAdmin && (
                <button className="mt-2 text-xs text-brand-300 hover:underline" onClick={() => (setXpLevel(data.profile!.level), setXpOpen(true))}>
                  Level manuell setzen
                </button>
              )}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-line p-4">
              <div className="mb-3 text-sm font-medium">Aktivität (30 Tage)</div>
              <div className="h-48">
                <ResponsiveContainer>
                  <AreaChart data={data.series}>
                    <GradientDefs id="gProfile" color={CHART.violet} />
                    <CartesianGrid stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="date" tickFormatter={shortDay} {...axisProps} minTickGap={24} />
                    <YAxis {...axisProps} width={30} allowDecimals={false} />
                    <Tooltip content={<ChartTooltip labelFormatter={shortDay} />} />
                    <Area dataKey="messages" name="Nachrichten" stroke={CHART.violet} fill="url(#gProfile)" strokeWidth={2} />
                    <Area dataKey="voiceMinutes" name="Voice-Min." stroke={CHART.yellow} fill="transparent" strokeWidth={1.5} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="rounded-xl border border-line p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Shield className="h-4 w-4" />Rollen</div>
              <div className="flex flex-wrap gap-1.5">
                {m.roles.length === 0 && <span className="text-sm text-fg-subtle">Keine Rollen</span>}
                {m.roles.map((r) => (
                  <RoleChip key={r} id={r} onRemove={canMod && m.inGuild ? () => roles.mutate({ remove: [r] }) : undefined} />
                ))}
              </div>
              {canMod && m.inGuild && (
                <div className="mt-4 flex gap-2">
                  <div className="flex-1">
                    <RoleSelect assignable value={addRole} onChange={setAddRole} placeholder="Rolle hinzufügen …" />
                  </div>
                  <Button disabled={!addRole} loading={roles.isPending} onClick={() => addRole && roles.mutate({ add: [addRole] })}>
                    Hinzufügen
                  </Button>
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-line">
              <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-medium"><Gavel className="h-4 w-4" />Moderationshistorie</div>
              <div className="max-h-64 overflow-y-auto">
                {data.cases.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-fg-subtle">Keine Einträge</p>
                ) : (
                  data.cases.map((c) => (
                    <div key={c.id} className="flex items-start gap-3 border-b border-line/50 px-4 py-2.5 last:border-0">
                      <Badge color={CASE_COLOR[c.type]}>{CASE_LABEL[c.type]}</Badge>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm">{c.reason ?? <span className="text-fg-subtle">Kein Grund</span>}</div>
                        <div className="text-xs text-fg-subtle">#{c.caseNumber} · {relative(c.createdAt)} {!c.active && '· inaktiv'}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="rounded-xl border border-line">
              <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-medium"><Coins className="h-4 w-4" />Economy & Tickets</div>
              <div className="px-4 py-2">
                <KeyValue label="Wallet" value={num(data.account?.wallet ?? 0)} />
                <KeyValue label="Bank" value={num(data.account?.bank ?? 0)} />
                <KeyValue label="Insgesamt verdient" value={num(data.account?.totalEarned ?? 0)} />
                <KeyValue label="Job / Firma" value={`${data.account?.job?.name ?? '—'} / ${data.account?.company?.name ?? '—'}`} />
                <KeyValue label="Inventar" value={data.inventory.length ? data.inventory.map((i) => `${i.item.emoji ?? ''} ${i.item.name} ×${i.quantity}`).join(', ') : '—'} />
                <KeyValue label={<span className="flex items-center gap-1"><Ticket className="h-3.5 w-3.5" />Tickets</span>} value={num(data.tickets)} />
              </div>
            </div>
          </div>
        </div>
      )}
      {modOpen && m && <ModActionModal open onClose={() => setModOpen(false)} userId={m.id} username={m.displayName} />}
      <Modal open={xpOpen} onClose={() => setXpOpen(false)} size="sm" title="Level setzen" footer={<Button variant="primary" loading={setXp.isPending} onClick={() => setXp.mutate()}>Speichern</Button>}>
        <Field label="Neues Level" hint="Die XP werden passend zur Levelkurve gesetzt; Levelrollen werden angepasst.">
          <NumberInput value={xpLevel} min={0} max={1000} onChange={setXpLevel} />
        </Field>
      </Modal>
    </Modal>
  );
}

function MemberList({ onOpen }: { onOpen: (id: string) => void }) {
  const guildId = useGuildId();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [roleId, setRoleId] = useState<string | null>(null);
  const [bots, setBots] = useState<'all' | 'humans' | 'bots'>('humans');
  const [offset, setOffset] = useState(0);
  const limit = 50;
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(query);
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['members', guildId, debounced, roleId, bots, offset],
    queryFn: () => api.get<{ total: number; cached: number; memberCount: number; items: MemberRow[] }>(`/guilds/${guildId}/members${qs({ query: debounced, roleId, bots, offset, limit })}`),
    placeholderData: (prev) => prev,
  });
  const { roleName } = useLookup();
  return (
    <Card>
      <CardHeader
        title="Mitgliederliste"
        description={data ? `${num(data.total)} Treffer · ${num(data.cached)} von ${num(data.memberCount)} Mitgliedern geladen` : undefined}
        icon={Users}
        actions={
          <>
            <div className="relative w-56">
              <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
              <Input className="pl-9" placeholder="Name oder ID …" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="w-48">
              <RoleSelect value={roleId} onChange={(v) => (setRoleId(v), setOffset(0))} placeholder="Alle Rollen" />
            </div>
            <Select value={bots} onChange={(e) => (setBots(e.target.value as typeof bots), setOffset(0))} className="w-36">
              <option value="humans">Nur Menschen</option>
              <option value="bots">Nur Bots</option>
              <option value="all">Alle</option>
            </Select>
          </>
        }
      />
      {isLoading ? (
        <LoadingBlock />
      ) : error ? (
        <div className="p-5"><ErrorState error={error} onRetry={() => refetch()} /></div>
      ) : !data?.items.length ? (
        <EmptyState icon={Users} title="Keine Mitglieder gefunden" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-fg-subtle uppercase">
              <tr className="border-b border-line">
                <th className="px-5 py-3 font-medium">Mitglied</th>
                <th className="px-3 py-3 font-medium">Rollen</th>
                <th className="px-3 py-3 font-medium">Level</th>
                <th className="px-3 py-3 font-medium">Nachrichten</th>
                <th className="px-3 py-3 font-medium">Beigetreten</th>
                <th className="px-5 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((m) => (
                <tr key={m.id} className="table-row cursor-pointer" onClick={() => onOpen(m.id)}>
                  <td className="px-5 py-2.5">
                    <div className="flex items-center gap-3">
                      <Avatar src={m.avatar} name={m.username} size={34} />
                      <div className="min-w-0">
                        <div className="truncate font-medium">{m.displayName}</div>
                        <div className="truncate text-xs text-fg-subtle">@{m.username}</div>
                      </div>
                    </div>
                  </td>
                  <td className="max-w-[240px] px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {m.roles.slice(0, 3).map((r) => <Badge key={r}>{roleName(r)}</Badge>)}
                      {m.roles.length > 3 && <Badge>+{m.roles.length - 3}</Badge>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">{m.level}</td>
                  <td className="px-3 py-2.5 text-fg-muted tabular-nums">{num(m.messages)}</td>
                  <td className="px-3 py-2.5 text-fg-muted">{date(m.joinedAt)}</td>
                  <td className="px-5 py-2.5">
                    <div className="flex gap-1.5">
                      {m.bot && <Badge color="blue">Bot</Badge>}
                      {m.timedOutUntil && <Badge color="yellow">Timeout</Badge>}
                      {m.warnings > 0 && <Badge color="red">{m.warnings} Verw.</Badge>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between px-5 py-3 text-sm text-fg-muted">
            <span>{offset + 1}–{Math.min(offset + limit, data.total)} von {num(data.total)}</span>
            <div className="flex gap-2">
              <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Zurück</Button>
              <Button size="sm" disabled={offset + limit >= data.total} onClick={() => setOffset(offset + limit)}>Weiter</Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function InactiveList({ onOpen }: { onOpen: (id: string) => void }) {
  const guildId = useGuildId();
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery({
    queryKey: ['members', 'inactive', guildId, days],
    queryFn: () => api.get<{ userId: string; username: string; avatarUrl: string; lastMessageAt: string | null; joinedAt: string | null; messages: number }[]>(`/guilds/${guildId}/members/inactive?days=${days}`),
  });
  return (
    <Card>
      <CardHeader
        title="Inaktive Mitglieder"
        description="Keine Nachricht seit dem gewählten Zeitraum. Automatische Aktionen lassen sich unter Automatisierungen einrichten."
        icon={Clock}
        actions={
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-44">
            {[7, 14, 30, 60, 90, 180].map((d) => <option key={d} value={d}>Seit {d} Tagen</option>)}
          </Select>
        }
      />
      {isLoading ? (
        <LoadingBlock />
      ) : !data?.length ? (
        <EmptyState icon={Sparkles} title="Keine inaktiven Mitglieder" description="Alle erfassten Mitglieder waren im Zeitraum aktiv." />
      ) : (
        <div className="divide-y divide-line/60">
          {data.map((m) => (
            <button key={m.userId} onClick={() => onOpen(m.userId)} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-panel-2/60">
              <Avatar src={m.avatarUrl} name={m.username} size={32} />
              <span className="flex-1 truncate text-sm font-medium">{m.username}</span>
              <span className="text-xs text-fg-muted">{m.lastMessageAt ? `Zuletzt aktiv ${relative(m.lastMessageAt)}` : `Nie geschrieben · beigetreten ${relative(m.joinedAt)}`}</span>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function MembersPage() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'all' | 'inactive'>('all');
  const openUser = params.get('user');
  useRoles();
  const open = (id: string) => setParams({ user: id });
  return (
    <>
      <PageHeader title="Mitglieder" description="Suchen, Rollen verwalten, Profile und Moderationshistorie" icon={Users} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'all', label: 'Alle Mitglieder', icon: Users }, { id: 'inactive', label: 'Inaktiv', icon: Clock }]} />
      {tab === 'all' ? <MemberList onOpen={open} /> : <InactiveList onOpen={open} />}
      {openUser && <MemberProfile userId={openUser} onClose={() => setParams({})} />}
    </>
  );
}
