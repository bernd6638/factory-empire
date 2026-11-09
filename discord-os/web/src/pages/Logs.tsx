import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, Filter, ScrollText, Search, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { api, qs } from '../lib/api';
import { dateTime, relative } from '../lib/format';
import type { LogEntry } from '../lib/types';
import { useLive } from '../lib/live';
import { useCan, useGuildId, useLookup, useModuleConfig } from '../hooks/guild';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, LoadingBlock, NumberInput, PageHeader, Select, Switch, Tabs } from '../components/ui/core';
import { ChannelSelect, MultiChannelSelect } from '../components/ui/pickers';
import { ModuleToggle, SaveBar } from '../components/ui/module';

const CATEGORIES = { messages: 'Nachrichten', members: 'Mitglieder', roles: 'Rollen', channels: 'Kanäle', moderation: 'Moderation', voice: 'Voice', server: 'Server' } as const;
const COLORS: Record<string, 'blue' | 'green' | 'violet' | 'brand' | 'red' | 'yellow' | 'gray'> = { messages: 'blue', members: 'green', roles: 'violet', channels: 'brand', moderation: 'red', voice: 'yellow', server: 'gray' };

function LogDetail({ entry }: { entry: LogEntry }) {
  const d = entry.data as Record<string, any>;
  return (
    <div className="space-y-2 bg-panel-2/40 px-5 py-3 text-xs">
      {d.before !== undefined && <div><span className="text-fg-subtle">Vorher: </span><span className="whitespace-pre-wrap text-fg-muted">{String(d.before ?? '—')}</span></div>}
      {d.after !== undefined && <div><span className="text-fg-subtle">Nachher: </span><span className="whitespace-pre-wrap">{String(d.after ?? '—')}</span></div>}
      {d.content && <div><span className="text-fg-subtle">Inhalt: </span><span className="whitespace-pre-wrap">{String(d.content)}</span></div>}
      <div className="flex flex-wrap gap-4 text-fg-subtle">
        {entry.actorId && <span>Akteur: <code>{entry.actorId}</code></span>}
        {entry.targetId && <span>Ziel: <code>{entry.targetId}</code></span>}
        {entry.channelId && <span>Kanal: <code>{entry.channelId}</code></span>}
        <span>{dateTime(entry.createdAt)}</span>
      </div>
    </div>
  );
}

function LogList() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const isAdmin = useCan('ADMIN');
  const { channelName } = useLookup();
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [userId, setUserId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const filters = { category, q, userId: /^\d{15,22}$/.test(userId) ? userId : '' };
  const key = ['logs', guildId, filters];
  const query = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => api.get<{ items: LogEntry[]; nextCursor: string | null }>(`/guilds/${guildId}/logs${qs({ ...filters, before: pageParam, limit: 50 })}`),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  // Neue Einträge live oben einfügen, wenn sie zum Filter passen
  useLive('log', (ev) => {
    const e = ev.data as LogEntry;
    if (filters.category && e.category !== filters.category) return;
    if (filters.q && !e.summary.toLowerCase().includes(filters.q.toLowerCase())) return;
    if (filters.userId && e.actorId !== filters.userId && e.targetId !== filters.userId) return;
    qc.setQueryData(key, (old: any) => (old ? { ...old, pages: [{ ...old.pages[0], items: [e, ...old.pages[0].items] }, ...old.pages.slice(1)] } : old));
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const pretty = (s: string) => s.replace(/<#(\d+)>/g, (_, id) => channelName(id)).replace(/<@!?(\d+)>/g, '@$1');
  return (
    <Card>
      <CardHeader
        title="Server-Protokoll"
        description="Neue Einträge erscheinen live"
        icon={ScrollText}
        actions={
          <>
            <div className="relative w-52"><Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle" /><Input className="pl-9" placeholder="Text suchen …" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <Input className="w-44" placeholder="User-ID" value={userId} onChange={(e) => setUserId(e.target.value.trim())} />
            <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-40">
              <option value="">Alle Kategorien</option>
              {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            {isAdmin && <a href={`/api/guilds/${guildId}/logs/export.csv${qs(filters)}`}><Button icon={Download}>CSV</Button></a>}
          </>
        }
      />
      {query.isLoading ? <LoadingBlock /> : query.error ? <div className="p-5"><ErrorState error={query.error} /></div> : !items.length ? (
        <EmptyState icon={Filter} title="Keine Einträge" description="Aktiviere das Logging-Modul und die gewünschten Ereignisse in den Einstellungen." />
      ) : (
        <div>
          <AnimatePresence initial={false}>
            {items.map((e) => (
              <motion.div key={e.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="border-b border-line/60">
                <button onClick={() => setOpen(open === e.id ? null : e.id)} className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-panel-2/50">
                  <Badge color={COLORS[e.category] ?? 'gray'} className="mt-0.5 w-24 justify-center">{CATEGORIES[e.category as keyof typeof CATEGORIES] ?? e.category}</Badge>
                  <span className="flex-1 text-sm leading-relaxed">{pretty(e.summary)}</span>
                  <span className="shrink-0 text-xs text-fg-subtle" title={dateTime(e.createdAt)}>{relative(e.createdAt)}</span>
                </button>
                {open === e.id && <LogDetail entry={e} />}
              </motion.div>
            ))}
          </AnimatePresence>
          {query.hasNextPage && <div className="p-4 text-center"><Button loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>Ältere laden</Button></div>}
        </div>
      )}
    </Card>
  );
}

const EVENT_LABELS: Record<string, string> = {
  messageDelete: 'Nachricht gelöscht',
  messageUpdate: 'Nachricht bearbeitet',
  memberJoin: 'Mitglied beigetreten',
  memberLeave: 'Mitglied verlassen',
  memberUpdate: 'Rollen & Nickname geändert',
  roleChanges: 'Rollen erstellt/geändert/gelöscht',
  channelChanges: 'Kanäle erstellt/geändert/gelöscht',
  moderation: 'Moderationsaktionen',
  voice: 'Voice-Aktivität',
};

function SettingsTab() {
  const m = useModuleConfig('logging');
  if (m.isLoading || !m.config) return <LoadingBlock />;
  const c = m.config;
  return (
    <div className="space-y-4">
      <ModuleToggle name="Logging" enabled={m.enabled} onChange={m.setEnabled} saving={m.saving} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Erfasste Ereignisse" description="Alle aktivierten Ereignisse erscheinen im Dashboard." icon={Filter} />
          <div className="space-y-1 p-5">
            {Object.entries(EVENT_LABELS).map(([k, label]) => (
              <Switch key={k} label={label} checked={c.events[k as keyof typeof c.events]} onChange={(v) => m.update((d) => void (d.events[k as keyof typeof d.events] = v))} />
            ))}
            <div className="border-t border-line pt-3"><Switch label="Nachrichten von Bots ignorieren" checked={c.ignoreBots} onChange={(v) => m.update((d) => void (d.ignoreBots = v))} /></div>
          </div>
        </Card>
        <Card>
          <CardHeader title="Discord-Log-Kanäle" description="Optional: Ereignisse zusätzlich als Embed in Discord posten" icon={Settings2} />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            {Object.entries(CATEGORIES).map(([k, label]) => (
              <Field key={k} label={label}><ChannelSelect value={c.channels[k as keyof typeof c.channels]} onChange={(v) => m.update((d) => void (d.channels[k as keyof typeof d.channels] = v))} placeholder="Nur Dashboard" /></Field>
            ))}
            <Field label="Ignorierte Kanäle" className="sm:col-span-2"><MultiChannelSelect value={c.ignoredChannelIds} onChange={(v) => m.update((d) => void (d.ignoredChannelIds = v))} /></Field>
            <Field label="Aufbewahrung" hint="Ältere Einträge werden automatisch gelöscht"><NumberInput value={c.retentionDays} min={1} max={365} suffix="Tage" onChange={(v) => m.update((d) => void (d.retentionDays = v))} /></Field>
          </div>
        </Card>
      </div>
      <SaveBar dirty={m.dirty} saving={m.saving} onSave={m.save} onReset={m.reset} />
    </div>
  );
}

export default function LogsPage() {
  const [tab, setTab] = useState<'list' | 'settings'>('list');
  return (
    <>
      <PageHeader title="Logs" description="Nachrichten, Mitglieder, Rollen, Kanäle, Voice und Moderation" icon={ScrollText} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'list', label: 'Protokoll', icon: ScrollText }, { id: 'settings', label: 'Einstellungen', icon: Settings2 }]} />
      {tab === 'list' ? <LogList /> : <SettingsTab />}
    </>
  );
}
