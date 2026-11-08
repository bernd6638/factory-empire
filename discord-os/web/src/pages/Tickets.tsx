import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Clock, Download, Hand, Inbox, LayoutPanelTop, Lock, Plus, Send, Settings2, Ticket as TicketIcon, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, qs } from '../lib/api';
import { avatarUrl, dateTime, duration, num, relative, shortDay } from '../lib/format';
import type { Paged, Ticket, TicketMessage } from '../lib/types';
import { useLive } from '../lib/live';
import { useCan, useGuildId, useModuleConfig } from '../hooks/guild';
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, LoadingBlock, NumberInput, PageHeader, Pagination, Select, StatCard, Switch, Tabs, Textarea } from '../components/ui/core';
import { Modal, useConfirm, useToast } from '../components/ui/overlay';
import { ChannelSelect, MultiRoleSelect } from '../components/ui/pickers';
import { ModuleToggle, SaveBar } from '../components/ui/module';
import { CHART, ChartTooltip, axisProps } from '../components/ui/chart';

const STATUS = { OPEN: { label: 'Offen', color: 'green' }, CLAIMED: { label: 'In Bearbeitung', color: 'blue' }, CLOSED: { label: 'Geschlossen', color: 'gray' } } as const;
const PRIORITY = { LOW: { label: 'Niedrig', color: 'green' }, NORMAL: { label: 'Normal', color: 'blue' }, HIGH: { label: 'Hoch', color: 'yellow' }, URGENT: { label: 'Dringend', color: 'red' } } as const;

function TicketDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [reply, setReply] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const key = ['ticket', guildId, id];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<{ ticket: Ticket; messages: TicketMessage[] }>(`/guilds/${guildId}/tickets/${id}`) });
  useLive('ticket.message', (ev) => {
    if (ev.data.ticketId !== id) return;
    qc.setQueryData<{ ticket: Ticket; messages: TicketMessage[] }>(key, (old) => (old && !old.messages.some((m) => m.id === ev.data.message.id) ? { ...old, messages: [...old.messages, ev.data.message] } : old));
  });
  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), [data?.messages.length]);
  const act = (path: string, body?: unknown, msg?: string) =>
    api.post(`/guilds/${guildId}/tickets/${id}/${path}`, body).then(() => {
      if (msg) toast.success(msg);
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    });
  const send = useMutation({ mutationFn: () => act('reply', { content: reply }), onSuccess: () => setReply(''), onError: toast.error });
  const close = useMutation({ mutationFn: (reason: string) => act('close', { reason }, 'Ticket geschlossen'), onError: toast.error });
  const claim = useMutation({ mutationFn: () => act('assign', {}, 'Ticket übernommen'), onError: toast.error });
  const prio = useMutation({ mutationFn: (priority: string) => act('priority', { priority }, 'Priorität geändert'), onError: toast.error });

  const t = data?.ticket;
  return (
    <Modal open onClose={onClose} size="lg" title={t ? `Ticket #${t.number}` : 'Ticket'} description={t ? `${t.categoryKey} · eröffnet von ${t.ownerTag ?? t.ownerId} · ${dateTime(t.createdAt)}` : undefined}>
      {isLoading ? <LoadingBlock /> : error || !t ? <ErrorState error={error} /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge color={STATUS[t.status].color}>{STATUS[t.status].label}</Badge>
            {t.status !== 'CLOSED' ? (
              <Select value={t.priority} onChange={(e) => prio.mutate(e.target.value)} className="w-40">
                {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>Priorität: {v.label}</option>)}
              </Select>
            ) : <Badge color={PRIORITY[t.priority].color}>{PRIORITY[t.priority].label}</Badge>}
            {t.assigneeId && <Badge color="violet">Zugewiesen: {t.assigneeId}</Badge>}
            <div className="ml-auto flex gap-2">
              {t.status === 'OPEN' && <Button size="sm" icon={Hand} loading={claim.isPending} onClick={() => claim.mutate()}>Übernehmen</Button>}
              {t.status === 'CLOSED' && <a href={`/api/guilds/${guildId}/tickets/${id}/transcript.txt`}><Button size="sm" icon={Download}>Transkript</Button></a>}
              {t.status !== 'CLOSED' && (
                <Button size="sm" variant="danger" icon={Lock} loading={close.isPending} onClick={async () => (await confirm({ title: `Ticket #${t.number} schließen?`, message: 'Das Transkript wird gespeichert und der Kanal geschlossen.', danger: true, confirmLabel: 'Schließen' })) && close.mutate('Über das Dashboard geschlossen')}>
                  Schließen
                </Button>
              )}
            </div>
          </div>
          {t.subject && <div className="rounded-xl border border-line bg-panel-2/50 p-3 text-sm"><span className="text-fg-muted">Betreff: </span>{t.subject}</div>}
          {t.closeReason && <div className="text-sm text-fg-muted">Schließgrund: {t.closeReason}</div>}
          <div className="max-h-[50vh] space-y-3 overflow-y-auto rounded-xl border border-line bg-base/40 p-4">
            {data!.messages.length === 0 && <p className="py-6 text-center text-sm text-fg-subtle">Keine Nachrichten</p>}
            {data!.messages.map((msg) => (
              <div key={msg.id} className="flex gap-3">
                <Avatar src={avatarUrl(msg.authorId, null)} name={msg.authorTag} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{msg.authorTag}</span>
                    {msg.authorBot && <Badge color="brand">Bot</Badge>}
                    <span className="text-[11px] text-fg-subtle">{dateTime(msg.createdAt)}</span>
                  </div>
                  <div className="text-sm whitespace-pre-wrap text-fg/90">{msg.content || <span className="text-fg-subtle italic">[Embed/Anhang]</span>}</div>
                  {msg.attachments?.map((a) => <a key={a.url} href={a.url} target="_blank" rel="noreferrer" className="block text-xs text-brand-300 hover:underline">📎 {a.name}</a>)}
                </div>
              </div>
            ))}
            <div ref={bottom} />
          </div>
          {t.status !== 'CLOSED' && (
            <div className="flex gap-2">
              <Textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Antwort im Ticket-Kanal senden …" className="min-h-[44px]" maxLength={1800} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && reply && send.mutate()} />
              <Button variant="primary" icon={Send} disabled={!reply.trim()} loading={send.isPending} onClick={() => send.mutate()} />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function TicketList() {
  const guildId = useGuildId();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('ACTIVE');
  const [priority, setPriority] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['tickets', guildId, status, priority, q, page],
    queryFn: () => api.get<Paged<Ticket>>(`/guilds/${guildId}/tickets${qs({ status, priority, q, page })}`),
    placeholderData: (p) => p,
  });
  const openId = params.get('ticket');
  return (
    <Card>
      <CardHeader
        title="Tickets"
        icon={Inbox}
        actions={
          <>
            <Input placeholder="Nr., Betreff, Nutzer …" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} className="w-48" />
            <Select value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))} className="w-40">
              <option value="ACTIVE">Aktiv</option>
              <option value="OPEN">Offen</option>
              <option value="CLAIMED">In Bearbeitung</option>
              <option value="CLOSED">Geschlossen</option>
              <option value="">Alle</option>
            </Select>
            <Select value={priority} onChange={(e) => (setPriority(e.target.value), setPage(1))} className="w-36">
              <option value="">Alle Prioritäten</option>
              {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </>
        }
      />
      {isLoading ? <LoadingBlock /> : error ? <div className="p-5"><ErrorState error={error} onRetry={() => refetch()} /></div> : !data?.items.length ? (
        <EmptyState icon={TicketIcon} title="Keine Tickets" description="Sende unter „Einstellungen“ ein Ticket-Panel, damit Mitglieder Tickets eröffnen können." />
      ) : (
        <>
          <div className="divide-y divide-line/60">
            {data.items.map((t) => (
              <button key={t.id} onClick={() => setParams({ ticket: String(t.id) })} className="flex w-full flex-wrap items-center gap-3 px-5 py-3.5 text-left transition hover:bg-panel-2/60">
                <span className="w-14 font-mono text-sm text-fg-muted">#{t.number}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{t.subject ?? <span className="text-fg-muted">Kein Betreff</span>}</div>
                  <div className="text-xs text-fg-subtle">{t.ownerTag ?? t.ownerId} · {t.categoryKey} · {relative(t.createdAt)}</div>
                </div>
                <Badge color={PRIORITY[t.priority].color}>{PRIORITY[t.priority].label}</Badge>
                <Badge color={STATUS[t.status].color} dot>{STATUS[t.status].label}</Badge>
              </button>
            ))}
          </div>
          <Pagination page={data.page} total={data.total} limit={data.limit} onChange={setPage} />
        </>
      )}
      {openId && <TicketDetail id={Number(openId)} onClose={() => setParams({})} />}
    </Card>
  );
}

function Stats() {
  const guildId = useGuildId();
  const { data, isLoading } = useQuery({
    queryKey: ['ticket-stats', guildId],
    queryFn: () => api.get<{ byStatus: { status: string; count: number }[]; byCategory: { category: string; count: number }[]; byPriority: { priority: string; count: number }[]; series: { date: string; opened: number }[]; avgCloseSeconds: number | null; avgClaimSeconds: number | null; topSupporters: { userId: string; count: number }[] }>(`/guilds/${guildId}/tickets/stats`),
  });
  if (isLoading || !data) return <LoadingBlock />;
  const count = (s: string) => data.byStatus.find((x) => x.status === s)?.count ?? 0;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Offen" value={num(count('OPEN'))} icon={Inbox} accent="green" />
        <StatCard label="In Bearbeitung" value={num(count('CLAIMED'))} icon={Hand} accent="blue" />
        <StatCard label="Ø Reaktionszeit" value={duration(data.avgClaimSeconds)} icon={Clock} accent="violet" hint="Bis zur Übernahme (30 T)" />
        <StatCard label="Ø Lösungszeit" value={duration(data.avgCloseSeconds)} icon={Lock} accent="yellow" hint="Bis zum Schließen (30 T)" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Neue Tickets pro Tag" icon={BarChart3} />
          <div className="h-64 p-4">
            <ResponsiveContainer>
              <BarChart data={data.series}>
                <CartesianGrid stroke={CHART.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={shortDay} {...axisProps} minTickGap={20} />
                <YAxis {...axisProps} width={30} allowDecimals={false} />
                <Tooltip content={<ChartTooltip labelFormatter={shortDay} />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                <Bar dataKey="opened" name="Eröffnet" fill={CHART.green} radius={[4, 4, 0, 0]} maxBarSize={16} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card>
          <CardHeader title="Nach Kategorie (30 T)" icon={TicketIcon} />
          <div className="space-y-2 p-5">
            {data.byCategory.length === 0 && <p className="text-sm text-fg-subtle">Keine Daten</p>}
            {data.byCategory.map((c) => <div key={c.category} className="flex justify-between text-sm"><span className="text-fg-muted">{c.category}</span><span>{c.count}</span></div>)}
            {data.topSupporters.length > 0 && (
              <div className="border-t border-line pt-3">
                <div className="label">Top-Supporter</div>
                {data.topSupporters.map((s) => <div key={s.userId} className="flex justify-between py-0.5 text-sm"><code className="text-xs text-fg-muted">{s.userId}</code><span>{s.count}</span></div>)}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function SettingsTab() {
  const guildId = useGuildId();
  const toast = useToast();
  const isAdmin = useCan('ADMIN');
  const m = useModuleConfig('tickets');
  const panel = useMutation({ mutationFn: () => api.post<{ updated: boolean }>(`/guilds/${guildId}/tickets/panel`), onSuccess: (r) => toast.success(r.updated ? 'Panel aktualisiert' : 'Panel gesendet'), onError: toast.error });
  if (m.isLoading || !m.config) return <LoadingBlock />;
  const c = m.config;
  return (
    <div className="space-y-4">
      <ModuleToggle name="Tickets" enabled={m.enabled} onChange={m.setEnabled} saving={m.saving} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Ticket-Panel" description="Nachricht mit Buttons, über die Mitglieder Tickets öffnen" icon={LayoutPanelTop} actions={isAdmin && <Button variant="primary" icon={Send} loading={panel.isPending} disabled={m.dirty || !m.enabled} onClick={() => panel.mutate()} title={m.dirty ? 'Zuerst speichern' : undefined}>{c.panel.messageId ? 'Panel aktualisieren' : 'Panel senden'}</Button>} />
          <div className="space-y-4 p-5">
            <Field label="Panel-Kanal"><ChannelSelect value={c.panel.channelId} onChange={(v) => m.update((d) => void ((d.panel.channelId = v), (d.panel.messageId = null)))} /></Field>
            <Field label="Titel"><Input value={c.panel.title} maxLength={256} onChange={(e) => m.update((d) => void (d.panel.title = e.target.value))} /></Field>
            <Field label="Beschreibung"><Textarea value={c.panel.description} maxLength={2000} onChange={(e) => m.update((d) => void (d.panel.description = e.target.value))} /></Field>
            <Field label="Farbe"><div className="flex items-center gap-2"><input type="color" value={c.panel.color} onChange={(e) => m.update((d) => void (d.panel.color = e.target.value))} className="h-10 w-12 rounded-lg border border-line bg-panel-2" /><Input value={c.panel.color} onChange={(e) => m.update((d) => void (d.panel.color = e.target.value))} className="w-28" /></div></Field>
            <div className="rounded-xl border border-line bg-[#313338] p-4">
              <div className="border-l-4 pl-3" style={{ borderColor: c.panel.color }}>
                <div className="font-semibold text-white">{c.panel.title}</div>
                <div className="mt-1 text-sm whitespace-pre-wrap text-[#dbdee1]">{c.panel.description}</div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">{c.categories.map((cat) => <span key={cat.key} className="rounded bg-[#4e5058] px-3 py-1.5 text-sm text-white">{cat.emoji} {cat.label}</span>)}</div>
            </div>
          </div>
        </Card>
        <Card>
          <CardHeader title="Allgemein" icon={Settings2} />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Kategorie für neue Tickets"><ChannelSelect kinds={['category']} value={c.categoryChannelId} onChange={(v) => m.update((d) => void (d.categoryChannelId = v))} /></Field>
            <Field label="Transkript-Kanal"><ChannelSelect value={c.transcriptChannelId} onChange={(v) => m.update((d) => void (d.transcriptChannelId = v))} /></Field>
            <Field label="Support-Rollen" className="sm:col-span-2"><MultiRoleSelect value={c.supportRoleIds} onChange={(v) => m.update((d) => void (d.supportRoleIds = v))} /></Field>
            <Field label="Max. offene Tickets pro Nutzer"><NumberInput value={c.maxOpenPerUser} min={1} max={10} onChange={(v) => m.update((d) => void (d.maxOpenPerUser = v))} /></Field>
            <Field label="Kanalname" hint="{number} {user} {category}"><Input value={c.namePattern} onChange={(e) => m.update((d) => void (d.namePattern = e.target.value))} /></Field>
            <Field label="Beim Schließen">
              <Select value={c.closeAction} onChange={(e) => m.update((d) => void (d.closeAction = e.target.value as 'delete' | 'archive'))}>
                <option value="delete">Kanal löschen</option>
                <option value="archive">In Archiv verschieben</option>
              </Select>
            </Field>
            {c.closeAction === 'archive' && <Field label="Archiv-Kategorie"><ChannelSelect kinds={['category']} value={c.archiveCategoryId} onChange={(v) => m.update((d) => void (d.archiveCategoryId = v))} /></Field>}
            <div className="sm:col-span-2"><Switch label="Support-Team pingen" checked={c.pingSupport} onChange={(v) => m.update((d) => void (d.pingSupport = v))} /></div>
            <Field label="Standard-Begrüßung" className="sm:col-span-2" hint="{user} {username} {server} {category}"><Textarea value={c.defaultWelcome} maxLength={2000} onChange={(e) => m.update((d) => void (d.defaultWelcome = e.target.value))} /></Field>
          </div>
        </Card>
      </div>
      <Card>
        <CardHeader title="Ticket-Kategorien" description="Bis zu 10 Kategorien (bis 5 als Buttons, darüber als Auswahlmenü)" icon={TicketIcon} actions={<Button icon={Plus} disabled={c.categories.length >= 10} onClick={() => m.update((d) => void d.categories.push({ key: `kategorie-${d.categories.length + 1}`, label: 'Neue Kategorie', emoji: '📩', description: '', supportRoleIds: [], welcomeMessage: '' }))}>Kategorie</Button>} />
        <div className="grid gap-4 p-5 lg:grid-cols-2">
          {c.categories.map((cat, i) => (
            <div key={i} className="space-y-3 rounded-xl border border-line bg-panel-2/40 p-4">
              <div className="grid grid-cols-[70px_1fr_1fr_auto] items-end gap-2">
                <Field label="Emoji"><Input value={cat.emoji} maxLength={64} onChange={(e) => m.update((d) => void (d.categories[i]!.emoji = e.target.value))} /></Field>
                <Field label="Name"><Input value={cat.label} maxLength={80} onChange={(e) => m.update((d) => void (d.categories[i]!.label = e.target.value))} /></Field>
                <Field label="Schlüssel"><Input value={cat.key} maxLength={32} onChange={(e) => m.update((d) => void (d.categories[i]!.key = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-')))} /></Field>
                <Button size="icon" variant="ghost" icon={Trash2} disabled={c.categories.length <= 1} onClick={() => m.update((d) => void d.categories.splice(i, 1))} />
              </div>
              <Field label="Beschreibung"><Input value={cat.description} maxLength={100} onChange={(e) => m.update((d) => void (d.categories[i]!.description = e.target.value))} /></Field>
              <Field label="Zusätzliche Support-Rollen"><MultiRoleSelect value={cat.supportRoleIds} onChange={(v) => m.update((d) => void (d.categories[i]!.supportRoleIds = v))} /></Field>
              <Field label="Eigene Begrüßung" hint="Leer = Standard-Begrüßung"><Textarea value={cat.welcomeMessage} maxLength={2000} className="min-h-[64px]" onChange={(e) => m.update((d) => void (d.categories[i]!.welcomeMessage = e.target.value))} /></Field>
            </div>
          ))}
        </div>
      </Card>
      <SaveBar dirty={m.dirty} saving={m.saving} onSave={m.save} onReset={m.reset} />
    </div>
  );
}

export default function TicketsPage() {
  const [tab, setTab] = useState<'list' | 'stats' | 'settings'>('list');
  return (
    <>
      <PageHeader title="Tickets" description="Support-Anfragen bearbeiten, Statistiken und Panel-Konfiguration" icon={TicketIcon} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'list', label: 'Tickets', icon: Inbox }, { id: 'stats', label: 'Statistik', icon: BarChart3 }, { id: 'settings', label: 'Einstellungen', icon: Settings2 }]} />
      {tab === 'list' && <TicketList />}
      {tab === 'stats' && <Stats />}
      {tab === 'settings' && <SettingsTab />}
    </>
  );
}
