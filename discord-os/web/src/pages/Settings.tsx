import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, History, KeyRound, Plus, Settings as SettingsIcon, Shield, Trash2, UserCog } from 'lucide-react';
import { useState } from 'react';
import { api, qs } from '../lib/api';
import { dateTime } from '../lib/format';
import type { Paged } from '../lib/types';
import { useCan, useGuild, useGuildId, useLookup } from '../hooks/guild';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, KeyValue, LoadingBlock, PageHeader, Pagination, Select, Tabs } from '../components/ui/core';
import { useConfirm, useToast } from '../components/ui/overlay';
import { RoleSelect } from '../components/ui/pickers';

interface Perm { id: number; targetType: 'ROLE' | 'USER'; targetId: string; level: 'VIEWER' | 'MODERATOR' | 'ADMIN'; createdAt: string }
interface Audit { id: number; userId: string; username: string; action: string; details: unknown; ip: string | null; createdAt: string }

const LEVELS = { VIEWER: { label: 'Betrachter', desc: 'Dashboard, Statistiken, Mitglieder ansehen', color: 'gray' }, MODERATOR: { label: 'Moderator', desc: 'Zusätzlich Moderation, Tickets, Logs, Rollen vergeben', color: 'blue' }, ADMIN: { label: 'Administrator', desc: 'Zusätzlich alle Einstellungen ändern', color: 'violet' } } as const;

function PermissionsTab() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const isOwner = useCan('OWNER');
  const { roleName } = useLookup();
  const [type, setType] = useState<'ROLE' | 'USER'>('ROLE');
  const [target, setTarget] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  const [level, setLevel] = useState<Perm['level']>('MODERATOR');
  const { data, isLoading } = useQuery({ queryKey: ['perms', guildId], queryFn: () => api.get<Perm[]>(`/guilds/${guildId}/settings/permissions`) });
  const add = useMutation({
    mutationFn: () => api.post(`/guilds/${guildId}/settings/permissions`, { targetType: type, targetId: type === 'ROLE' ? target : userId.trim(), level }),
    onSuccess: () => (toast.success('Berechtigung gespeichert'), setTarget(null), setUserId(''), void qc.invalidateQueries({ queryKey: ['perms', guildId] })),
    onError: toast.error,
  });
  const del = useMutation({ mutationFn: (id: number) => api.del(`/guilds/${guildId}/settings/permissions/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['perms', guildId] }), onError: toast.error });
  const valid = type === 'ROLE' ? !!target : /^\d{15,22}$/.test(userId.trim());
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="Dashboard-Berechtigungen" description="Server-Besitzer und Mitglieder mit „Server verwalten“ haben immer vollen Zugriff." icon={UserCog} />
        {isLoading ? <LoadingBlock /> : !data?.length ? <EmptyState icon={Shield} title="Keine zusätzlichen Berechtigungen" description="Gib Moderatoren-Rollen Zugriff auf das Dashboard, ohne ihnen Discord-Adminrechte zu geben." /> : (
          <div className="divide-y divide-line/60">
            {data.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-5 py-3">
                <Badge color={p.targetType === 'ROLE' ? 'brand' : 'gray'}>{p.targetType === 'ROLE' ? 'Rolle' : 'Nutzer'}</Badge>
                <span className="flex-1 truncate text-sm font-medium">{p.targetType === 'ROLE' ? (p.targetId === guildId ? '@everyone' : roleName(p.targetId)) : <code>{p.targetId}</code>}</span>
                <Badge color={LEVELS[p.level].color}>{LEVELS[p.level].label}</Badge>
                {(p.level !== 'ADMIN' || isOwner) && <Button size="icon" variant="ghost" icon={Trash2} onClick={async () => (await confirm({ title: 'Berechtigung entfernen?' })) && del.mutate(p.id)} />}
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Zugriff vergeben" icon={Plus} />
        <div className="space-y-4 p-5">
          <Field label="Typ">
            <Select value={type} onChange={(e) => setType(e.target.value as 'ROLE' | 'USER')}>
              <option value="ROLE">Rolle</option>
              <option value="USER">Einzelner Nutzer</option>
            </Select>
          </Field>
          {type === 'ROLE' ? <Field label="Rolle"><RoleSelect includeEveryone value={target} onChange={setTarget} /></Field> : <Field label="User-ID"><Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="123456789012345678" /></Field>}
          <Field label="Stufe">
            <div className="space-y-2">
              {(Object.keys(LEVELS) as Perm['level'][]).map((l) => (
                <button key={l} disabled={l === 'ADMIN' && !isOwner} onClick={() => setLevel(l)} className={`w-full rounded-xl border p-3 text-left transition disabled:opacity-40 ${level === l ? 'border-brand-500/60 bg-brand-500/10' : 'border-line bg-panel-2/50 hover:border-line-strong'}`}>
                  <div className="text-sm font-medium">{LEVELS[l].label}</div>
                  <div className="text-xs text-fg-subtle">{LEVELS[l].desc}{l === 'ADMIN' && !isOwner ? ' (nur Besitzer)' : ''}</div>
                </button>
              ))}
            </div>
          </Field>
          <Button variant="primary" className="w-full" disabled={!valid} loading={add.isPending} onClick={() => add.mutate()}>Speichern</Button>
        </div>
      </Card>
    </div>
  );
}

function AuditTab() {
  const guildId = useGuildId();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['audit', guildId, page], queryFn: () => api.get<Paged<Audit>>(`/guilds/${guildId}/settings/audit${qs({ page, limit: 30 })}`), placeholderData: (p) => p });
  return (
    <Card>
      <CardHeader title="Audit-Log" description="Alle Änderungen über das Dashboard – wer hat wann was getan" icon={History} />
      {isLoading ? <LoadingBlock /> : !data?.items.length ? <EmptyState icon={History} title="Noch keine Einträge" /> : (
        <>
          <div className="divide-y divide-line/60">
            {data.items.map((a) => (
              <div key={a.id}>
                <button onClick={() => setOpen(open === a.id ? null : a.id)} className="flex w-full items-center gap-3 px-5 py-3 text-left text-sm hover:bg-panel-2/50">
                  <code className="rounded bg-panel-3 px-2 py-0.5 text-xs text-brand-300">{a.action}</code>
                  <span className="flex-1 truncate text-fg-muted">{a.username}</span>
                  <span className="text-xs text-fg-subtle">{dateTime(a.createdAt)}</span>
                </button>
                {open === a.id && <pre className="max-h-64 overflow-auto bg-panel-2/40 px-5 py-3 text-xs text-fg-muted">{JSON.stringify(a.details, null, 2)}{a.ip ? `\nIP: ${a.ip}` : ''}</pre>}
              </div>
            ))}
          </div>
          <Pagination page={data.page} total={data.total} limit={data.limit} onChange={setPage} />
        </>
      )}
    </Card>
  );
}

function GeneralTab() {
  const { data: guild } = useGuild();
  const { data: meta } = useQuery({ queryKey: ['meta'], queryFn: () => api.get<{ version: string; inviteUrl: string; clientId: string }>('/meta') });
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Discord OS" icon={SettingsIcon} />
        <div className="px-5 py-3">
          <KeyValue label="Version" value={meta?.version ?? '—'} />
          <KeyValue label="Server" value={guild?.name} />
          <KeyValue label="Deine Zugriffsstufe" value={guild?.access} />
          <KeyValue label="Bot-Client-ID" value={<code className="text-xs">{meta?.clientId}</code>} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Bot-Berechtigungen" description="Fehlen Rechte, lade den Bot mit diesem Link erneut ein – vorhandene Einstellungen bleiben erhalten." icon={KeyRound} />
        <div className="space-y-4 p-5">
          {guild?.live?.botMissing.length ? <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-sm text-amber-200">Fehlend: {guild.live.botMissing.join(', ')}</div> : <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-sm text-emerald-300">Alle benötigten Berechtigungen sind vorhanden.</div>}
          {meta && <a href={`${meta.inviteUrl}&guild_id=${guild?.id}&disable_guild_select=true`} target="_blank" rel="noreferrer"><Button icon={ExternalLink}>Bot-Rechte aktualisieren</Button></a>}
        </div>
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<'perms' | 'audit' | 'general'>('perms');
  return (
    <>
      <PageHeader title="Einstellungen" description="Dashboard-Zugriff, Audit-Log und Bot-Informationen" icon={SettingsIcon} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'perms', label: 'Berechtigungen', icon: UserCog }, { id: 'audit', label: 'Audit-Log', icon: History }, { id: 'general', label: 'Allgemein', icon: SettingsIcon }]} />
      {tab === 'perms' && <PermissionsTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'general' && <GeneralTab />}
    </>
  );
}
