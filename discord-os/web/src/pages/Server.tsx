import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Info, KeyRound, Layers, Lock, Minus, Pencil, Plus, Server, Shield, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { cn, date, num } from '../lib/format';
import { PERMISSIONS, hasBit, toggleBit } from '../lib/permissions';
import { CHANNEL_TYPE, type Channel, type Role } from '../lib/types';
import { useCan, useChannels, useGuild, useGuildId, useRoles } from '../hooks/guild';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, KeyValue, LoadingBlock, PageHeader, Select, Switch, Tabs } from '../components/ui/core';
import { Modal, useConfirm, useToast } from '../components/ui/overlay';
import { ChannelIcon, ChannelSelect, RoleSelect } from '../components/ui/pickers';

type Tab = 'overview' | 'channels' | 'roles';

const VERIFICATION = ['Keine', 'Niedrig (verifizierte E-Mail)', 'Mittel (5 Min. registriert)', 'Hoch (10 Min. Mitglied)', 'Sehr hoch (Telefon)'];
const CONTENT_FILTER = ['Aus', 'Mitglieder ohne Rolle', 'Alle Mitglieder'];

function OverviewTab() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const canEdit = useCan('ADMIN');
  const { data: guild } = useGuild();
  const live = guild?.live;
  const [form, setForm] = useState({ name: '', verificationLevel: 0, explicitContentFilter: 0, defaultMessageNotifications: 0, systemChannelId: null as string | null, afkChannelId: null as string | null, afkTimeout: 300 });
  useEffect(() => {
    if (live) setForm({ name: live.name, verificationLevel: live.verificationLevel, explicitContentFilter: live.explicitContentFilter, defaultMessageNotifications: live.defaultMessageNotifications, systemChannelId: live.systemChannelId, afkChannelId: live.afkChannelId, afkTimeout: live.afkTimeout });
  }, [live]);
  const save = useMutation({
    mutationFn: () => api.patch(`/guilds/${guildId}/server/settings`, form),
    onSuccess: () => {
      toast.success('Servereinstellungen gespeichert');
      void qc.invalidateQueries({ queryKey: ['guild', guildId] });
    },
    onError: toast.error,
  });
  if (!live) return <ErrorState error={new Error('Live-Daten nicht verfügbar – ist der Bot online?')} />;
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card>
        <CardHeader title="Serverinformationen" icon={Info} />
        <div className="px-5 py-3">
          <KeyValue label="Server-ID" value={<code className="text-xs">{live.id}</code>} />
          <KeyValue label="Erstellt" value={date(live.createdAt)} />
          <KeyValue label="Mitglieder" value={num(live.memberCount)} />
          <KeyValue label="Im Cache" value={num(live.cachedMembers)} />
          <KeyValue label="Kanäle" value={num(live.channelCount)} />
          <KeyValue label="Rollen" value={num(live.roleCount)} />
          <KeyValue label="Emojis" value={num(live.emojiCount)} />
          <KeyValue label="Boosts" value={`${live.boosts} (Stufe ${live.boostTier})`} />
          <KeyValue label="Sprache" value={live.preferredLocale} />
        </div>
      </Card>
      <Card className="xl:col-span-2">
        <CardHeader title="Servereinstellungen" description="Änderungen werden direkt über den Bot in Discord übernommen." icon={Server} actions={canEdit && <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Speichern</Button>} />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Servername" className="sm:col-span-2">
            <Input value={form.name} disabled={!canEdit} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} />
          </Field>
          <Field label="Verifizierungsstufe">
            <Select value={form.verificationLevel} disabled={!canEdit} onChange={(e) => setForm({ ...form, verificationLevel: Number(e.target.value) })}>
              {VERIFICATION.map((v, i) => <option key={i} value={i}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Filter für explizite Inhalte">
            <Select value={form.explicitContentFilter} disabled={!canEdit} onChange={(e) => setForm({ ...form, explicitContentFilter: Number(e.target.value) })}>
              {CONTENT_FILTER.map((v, i) => <option key={i} value={i}>{v}</option>)}
            </Select>
          </Field>
          <Field label="Standard-Benachrichtigungen">
            <Select value={form.defaultMessageNotifications} disabled={!canEdit} onChange={(e) => setForm({ ...form, defaultMessageNotifications: Number(e.target.value) })}>
              <option value={0}>Alle Nachrichten</option>
              <option value={1}>Nur Erwähnungen</option>
            </Select>
          </Field>
          <Field label="Systemnachrichten-Kanal">
            <ChannelSelect value={form.systemChannelId} onChange={(v) => setForm({ ...form, systemChannelId: v })} />
          </Field>
          <Field label="AFK-Kanal">
            <ChannelSelect kinds={['voice']} value={form.afkChannelId} onChange={(v) => setForm({ ...form, afkChannelId: v })} />
          </Field>
          <Field label="AFK-Timeout">
            <Select value={form.afkTimeout} disabled={!canEdit} onChange={(e) => setForm({ ...form, afkTimeout: Number(e.target.value) })}>
              {[60, 300, 900, 1800, 3600].map((s) => <option key={s} value={s}>{s / 60} Minuten</option>)}
            </Select>
          </Field>
        </div>
        {live.botMissing.length > 0 && (
          <div className="mx-5 mb-5 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-200">
            <div className="mb-1 font-medium">Dem Bot fehlen Berechtigungen</div>
            {live.botMissing.join(', ')} – einige Funktionen sind dadurch eingeschränkt.
          </div>
        )}
      </Card>
    </div>
  );
}

type Tri = 'allow' | 'deny' | 'neutral';

function OverwriteEditor({ channel, target, onClose }: { channel: Channel; target: { id: string; type: 'role' | 'member'; allow: string; deny: string; name: string }; onClose: () => void }) {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const [allow, setAllow] = useState(target.allow);
  const [deny, setDeny] = useState(target.deny);
  const state = (bit: bigint): Tri => (hasBit(allow, bit) ? 'allow' : hasBit(deny, bit) ? 'deny' : 'neutral');
  const set = (bit: bigint, s: Tri) => {
    setAllow((a) => toggleBit(a, bit, s === 'allow'));
    setDeny((d) => toggleBit(d, bit, s === 'deny'));
  };
  const save = useMutation({
    mutationFn: () => api.put(`/guilds/${guildId}/server/channels/${channel.id}/permissions/${target.id}`, { targetType: target.type, allow, deny }),
    onSuccess: () => {
      toast.success('Berechtigungen gespeichert');
      void qc.invalidateQueries({ queryKey: ['channels', guildId] });
      onClose();
    },
    onError: toast.error,
  });
  const groups = [...new Set(PERMISSIONS.filter((p) => p.key !== 'Administrator' && p.key !== 'ManageGuild').map((p) => p.group))];
  return (
    <Modal open onClose={onClose} size="lg" title={`Berechtigungen: ${target.name}`} description={`Kanal #${channel.name}`} footer={<><Button variant="ghost" onClick={onClose}>Abbrechen</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Speichern</Button></>}>
      <div className="space-y-5">
        {groups.map((g) => (
          <div key={g}>
            <div className="label">{g}</div>
            <div className="divide-y divide-line/60 rounded-xl border border-line">
              {PERMISSIONS.filter((p) => p.group === g && p.key !== 'Administrator' && p.key !== 'ManageGuild').map((p) => {
                const s = state(p.bit);
                return (
                  <div key={p.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="text-sm">{p.label}</span>
                    <div className="flex overflow-hidden rounded-lg border border-line">
                      {(['deny', 'neutral', 'allow'] as Tri[]).map((t) => (
                        <button
                          key={t}
                          onClick={() => set(p.bit, t)}
                          className={cn('flex h-8 w-9 items-center justify-center transition', s === t ? (t === 'allow' ? 'bg-emerald-500/20 text-emerald-300' : t === 'deny' ? 'bg-red-500/20 text-red-300' : 'bg-panel-3 text-fg') : 'text-fg-subtle hover:bg-panel-2')}
                          title={t === 'allow' ? 'Erlauben' : t === 'deny' ? 'Verweigern' : 'Neutral'}
                        >
                          {t === 'allow' ? <Check className="h-4 w-4" /> : t === 'deny' ? <X className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function ChannelsTab() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const canEdit = useCan('ADMIN');
  const { data: channels, isLoading, error } = useChannels();
  const { data: roles } = useRoles();
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; type: 'role' | 'member'; allow: string; deny: string; name: string } | null>(null);
  const [addRole, setAddRole] = useState<string | null>(null);

  const tree = useMemo(() => {
    const list = channels ?? [];
    const cats = list.filter((c) => c.type === CHANNEL_TYPE.CATEGORY).sort((a, b) => a.position - b.position);
    const orphans = list.filter((c) => c.type !== CHANNEL_TYPE.CATEGORY && !c.parentId).sort((a, b) => a.position - b.position);
    return [{ cat: null as Channel | null, children: orphans }, ...cats.map((cat) => ({ cat, children: list.filter((c) => c.parentId === cat.id).sort((a, b) => a.position - b.position) }))];
  }, [channels]);

  const channel = channels?.find((c) => c.id === selected) ?? null;
  const roleName = (id: string) => (id === guildId ? '@everyone' : roles?.find((r) => r.id === id)?.name ?? `Mitglied ${id}`);

  const remove = useMutation({
    mutationFn: (targetId: string) => api.del(`/guilds/${guildId}/server/channels/${selected}/permissions/${targetId}`),
    onSuccess: () => {
      toast.success('Überschreibung entfernt');
      void qc.invalidateQueries({ queryKey: ['channels', guildId] });
    },
    onError: toast.error,
  });

  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorState error={error} />;

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-2">
        <CardHeader title="Kanäle & Kategorien" description={`${channels?.length ?? 0} Kanäle`} icon={Layers} />
        <div className="max-h-[640px] overflow-y-auto p-2">
          {tree.map(({ cat, children }) => (
            <div key={cat?.id ?? 'none'} className="mb-2">
              {cat && (
                <button onClick={() => setSelected(cat.id)} className={cn('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-semibold tracking-wider uppercase', selected === cat.id ? 'bg-brand-500/15 text-fg' : 'text-fg-subtle hover:text-fg-muted')}>
                  <ChevronRight className="h-3 w-3" /> {cat.name}
                </button>
              )}
              {children.map((c) => (
                <button key={c.id} onClick={() => setSelected(c.id)} className={cn('ml-2 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition', selected === c.id ? 'bg-brand-500/15 text-fg' : 'text-fg-muted hover:bg-panel-2 hover:text-fg')}>
                  <ChannelIcon type={c.type} className="h-4 w-4 text-fg-subtle" />
                  <span className="flex-1 truncate text-left">{c.name}</span>
                  {c.overwrites.some((o) => o.id === guildId && hasBit(o.deny, 1n << 10n)) && <Lock className="h-3 w-3 text-fg-subtle" />}
                </button>
              ))}
            </div>
          ))}
        </div>
      </Card>
      <Card className="lg:col-span-3">
        {!channel ? (
          <EmptyState icon={KeyRound} title="Kanal auswählen" description="Wähle links einen Kanal oder eine Kategorie, um Berechtigungen anzuzeigen und zu bearbeiten." />
        ) : (
          <>
            <CardHeader title={<span className="flex items-center gap-2"><ChannelIcon type={channel.type} /> {channel.name}</span>} description={channel.topic ?? 'Berechtigungsüberschreibungen'} icon={KeyRound} />
            <div className="space-y-2 p-5">
              {channel.overwrites.length === 0 && <p className="text-sm text-fg-muted">Keine Überschreibungen – der Kanal übernimmt die Serverrechte.</p>}
              {channel.overwrites.map((o) => {
                const allowCount = PERMISSIONS.filter((p) => hasBit(o.allow, p.bit)).length;
                const denyCount = PERMISSIONS.filter((p) => hasBit(o.deny, p.bit)).length;
                return (
                  <div key={o.id} className="flex items-center gap-3 rounded-xl border border-line bg-panel-2/50 px-4 py-3">
                    <Shield className="h-4 w-4 text-fg-subtle" />
                    <span className="flex-1 truncate text-sm font-medium">{roleName(o.id)}</span>
                    <Badge color="green">{allowCount} erlaubt</Badge>
                    <Badge color="red">{denyCount} verweigert</Badge>
                    {canEdit && (
                      <>
                        <Button size="icon" variant="ghost" icon={Pencil} onClick={() => setEditing({ ...o, name: roleName(o.id) })} />
                        <Button size="icon" variant="ghost" icon={Trash2} onClick={async () => (await confirm({ title: 'Überschreibung entfernen?', danger: true, confirmLabel: 'Entfernen' })) && remove.mutate(o.id)} />
                      </>
                    )}
                  </div>
                );
              })}
              {canEdit && (
                <div className="flex items-end gap-2 pt-3">
                  <Field label="Rolle hinzufügen" className="flex-1">
                    <RoleSelect includeEveryone value={addRole} onChange={setAddRole} />
                  </Field>
                  <Button icon={Plus} disabled={!addRole} onClick={() => addRole && (setEditing({ id: addRole, type: 'role', allow: '0', deny: '0', name: roleName(addRole) }), setAddRole(null))}>
                    Hinzufügen
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </Card>
      {editing && channel && <OverwriteEditor channel={channel} target={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RoleEditor({ role, onClose }: { role: Role | null; onClose: () => void }) {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ name: role?.name ?? 'Neue Rolle', color: role && role.color !== '#000000' ? role.color : '#6366f1', hoist: role?.hoist ?? false, mentionable: role?.mentionable ?? false, permissions: role?.permissions ?? '0' });
  const save = useMutation({
    mutationFn: () => (role ? api.patch(`/guilds/${guildId}/server/roles/${role.id}`, form) : api.post(`/guilds/${guildId}/server/roles`, form)),
    onSuccess: () => {
      toast.success(role ? 'Rolle aktualisiert' : 'Rolle erstellt');
      void qc.invalidateQueries({ queryKey: ['roles', guildId] });
      onClose();
    },
    onError: toast.error,
  });
  const groups = [...new Set(PERMISSIONS.map((p) => p.group))];
  return (
    <Modal open onClose={onClose} size="lg" title={role ? `Rolle bearbeiten: ${role.name}` : 'Neue Rolle'} footer={<><Button variant="ghost" onClick={onClose}>Abbrechen</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Speichern</Button></>}>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Field label="Name">
          <Input value={form.name} disabled={role?.everyone} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} />
        </Field>
        <Field label="Farbe">
          <div className="flex items-center gap-2">
            <input type="color" value={form.color} disabled={role?.everyone} onChange={(e) => setForm({ ...form, color: e.target.value })} className="h-10 w-12 cursor-pointer rounded-lg border border-line bg-panel-2" />
            <Input value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} className="w-28" disabled={role?.everyone} />
          </div>
        </Field>
      </div>
      <div className="mt-4 space-y-2">
        <Switch label="Getrennt anzeigen" description="Mitglieder dieser Rolle separat in der Mitgliederliste anzeigen" checked={form.hoist} onChange={(v) => setForm({ ...form, hoist: v })} />
        <Switch label="Erwähnbar" description="Jeder kann diese Rolle mit @ erwähnen" checked={form.mentionable} onChange={(v) => setForm({ ...form, mentionable: v })} />
      </div>
      <div className="mt-5 space-y-4">
        {groups.map((g) => (
          <div key={g}>
            <div className="label">{g}</div>
            <div className="grid gap-x-6 rounded-xl border border-line p-3 sm:grid-cols-2">
              {PERMISSIONS.filter((p) => p.group === g).map((p) => (
                <Switch key={p.key} label={<span className="text-sm font-normal">{p.label}</span>} checked={hasBit(form.permissions, p.bit)} onChange={(v) => setForm({ ...form, permissions: toggleBit(form.permissions, p.bit, v) })} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function RolesTab() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const canEdit = useCan('ADMIN');
  const { data: roles, isLoading, error } = useRoles();
  const [editing, setEditing] = useState<Role | null | 'new'>(null);
  const [q, setQ] = useState('');
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/guilds/${guildId}/server/roles/${id}`),
    onSuccess: () => {
      toast.success('Rolle gelöscht');
      void qc.invalidateQueries({ queryKey: ['roles', guildId] });
    },
    onError: toast.error,
  });
  if (isLoading) return <LoadingBlock />;
  if (error) return <ErrorState error={error} />;
  const list = (roles ?? []).filter((r) => r.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Card>
      <CardHeader
        title="Rollen"
        description="Die Reihenfolge entspricht der Hierarchie. Der Bot kann nur Rollen unterhalb seiner höchsten Rolle verwalten."
        icon={Shield}
        actions={
          <>
            <Input placeholder="Suchen …" value={q} onChange={(e) => setQ(e.target.value)} className="w-48" />
            {canEdit && <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>Neue Rolle</Button>}
          </>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-fg-subtle uppercase">
            <tr className="border-b border-line">
              <th className="px-5 py-3 font-medium">Rolle</th>
              <th className="px-3 py-3 font-medium">Mitglieder</th>
              <th className="px-3 py-3 font-medium">Eigenschaften</th>
              <th className="px-5 py-3" />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className="table-row">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <span className="h-3 w-3 rounded-full ring-2 ring-white/10" style={{ background: r.color !== '#000000' ? r.color : '#6b7286' }} />
                    <span className="font-medium" style={{ color: r.color !== '#000000' ? r.color : undefined }}>{r.everyone ? '@everyone' : r.name}</span>
                  </div>
                </td>
                <td className="px-3 py-3 text-fg-muted tabular-nums">{r.everyone ? '—' : num(r.memberCount)}</td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {hasBit(r.permissions, 1n << 3n) && <Badge color="red">Administrator</Badge>}
                    {r.managed && <Badge color="blue">Integration</Badge>}
                    {r.hoist && <Badge>Getrennt</Badge>}
                    {!r.editable && !r.everyone && <Badge color="yellow">Über Bot</Badge>}
                  </div>
                </td>
                <td className="px-5 py-3 text-right whitespace-nowrap">
                  {canEdit && r.editable && (
                    <>
                      <Button size="icon" variant="ghost" icon={Pencil} onClick={() => setEditing(r)} />
                      {!r.everyone && <Button size="icon" variant="ghost" icon={Trash2} onClick={async () => (await confirm({ title: `Rolle „${r.name}“ löschen?`, message: 'Die Rolle wird in Discord dauerhaft gelöscht.', danger: true, confirmLabel: 'Löschen' })) && del.mutate(r.id)} />}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <RoleEditor role={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

export default function ServerPage() {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <>
      <PageHeader title="Serververwaltung" description="Informationen, Kanäle, Rollen und Berechtigungen" icon={Server} />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Übersicht', icon: Info },
          { id: 'channels', label: 'Kanäle & Rechte', icon: Layers },
          { id: 'roles', label: 'Rollen', icon: Shield },
        ]}
      />
      {tab === 'overview' && <OverviewTab />}
      {tab === 'channels' && <ChannelsTab />}
      {tab === 'roles' && <RolesTab />}
    </>
  );
}
