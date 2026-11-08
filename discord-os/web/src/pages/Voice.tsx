import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Headphones, Lock, Mic, MicOff, Radio, Settings2, Trash2, Users, Volume2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { useCan, useGuildId, useModuleConfig } from '../hooks/guild';
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, Field, Input, LoadingBlock, NumberInput, PageHeader, StatCard, Switch, Tabs } from '../components/ui/core';
import { useConfirm, useToast } from '../components/ui/overlay';
import { ChannelSelect, MultiChannelSelect } from '../components/ui/pickers';
import { ModuleToggle, SaveBar } from '../components/ui/module';

interface VoiceData {
  temporary: { channelId: string; name: string; ownerId: string; locked: boolean; userLimit: number; createdAt: string; members: { id: string; username: string; avatar: string; muted: boolean; deaf: boolean }[] }[];
  active: { channelId: string; name: string; members: number }[];
  totalInVoice: number;
}

function LiveTab() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const canMod = useCan('MODERATOR');
  const { data, isLoading } = useQuery({ queryKey: ['voice', guildId], queryFn: () => api.get<VoiceData>(`/guilds/${guildId}/voice`), refetchInterval: 30_000 });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/guilds/${guildId}/voice/channels/${id}`), onSuccess: () => (toast.success('Kanal gelöscht'), void qc.invalidateQueries({ queryKey: ['voice'] })), onError: toast.error });
  if (isLoading || !data) return <LoadingBlock />;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Im Voice" value={data.totalInVoice} icon={Headphones} live />
        <StatCard label="Temporäre Kanäle" value={data.temporary.length} icon={Radio} accent="violet" />
        <StatCard label="Aktive Sprachkanäle" value={data.active.length} icon={Volume2} accent="green" />
      </div>
      <Card>
        <CardHeader title="Temporäre Kanäle" description="Automatisch erstellt über Join-to-Create" icon={Radio} />
        {!data.temporary.length ? <EmptyState icon={Mic} title="Keine temporären Kanäle" description="Sobald jemand einem Erstellen-Kanal beitritt, erscheint der neue Kanal hier live." /> : (
          <div className="grid gap-3 p-5 md:grid-cols-2">
            {data.temporary.map((t) => (
              <div key={t.channelId} className="rounded-xl border border-line bg-panel-2/50 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2 font-medium"><Volume2 className="h-4 w-4 text-fg-subtle" />{t.name}{t.locked && <Lock className="h-3.5 w-3.5 text-amber-300" />}</div>
                    <div className="mt-0.5 text-xs text-fg-subtle">Besitzer {t.ownerId} · erstellt {relative(t.createdAt)} · Limit {t.userLimit || '∞'}</div>
                  </div>
                  {canMod && <Button size="icon" variant="ghost" icon={Trash2} onClick={async () => (await confirm({ title: `Kanal „${t.name}“ löschen?`, message: 'Alle Mitglieder werden getrennt.', danger: true })) && del.mutate(t.channelId)} />}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {t.members.map((mb) => (
                    <span key={mb.id} className="flex items-center gap-1.5 rounded-full bg-panel-3 py-0.5 pr-2.5 pl-0.5 text-xs">
                      <Avatar src={mb.avatar} name={mb.username} size={20} />{mb.username}{(mb.muted || mb.deaf) && <MicOff className="h-3 w-3 text-red-300" />}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Alle aktiven Sprachkanäle" icon={Users} />
        {!data.active.length ? <p className="px-5 py-6 text-sm text-fg-subtle">Gerade ist niemand im Voice.</p> : (
          <div className="divide-y divide-line/60">{data.active.map((a) => <div key={a.channelId} className="flex items-center gap-3 px-5 py-2.5 text-sm"><Volume2 className="h-4 w-4 text-fg-subtle" /><span className="flex-1">{a.name}</span><Badge color="green">{a.members} verbunden</Badge></div>)}</div>
        )}
      </Card>
    </div>
  );
}

function SettingsTab() {
  const m = useModuleConfig('voice');
  if (m.isLoading || !m.config) return <LoadingBlock />;
  const c = m.config;
  return (
    <div className="space-y-4">
      <ModuleToggle name="Voice-Manager" enabled={m.enabled} onChange={m.setEnabled} saving={m.saving} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Join-to-Create" description="Betritt ein Mitglied einen dieser Kanäle, wird ein eigener Kanal erstellt." icon={Radio} />
          <div className="space-y-4 p-5">
            <Field label="Erstellen-Kanäle"><MultiChannelSelect kinds={['voice']} value={c.creatorChannelIds} onChange={(v) => m.update((d) => void (d.creatorChannelIds = v))} /></Field>
            <Field label="Kategorie für neue Kanäle" hint="Leer = Kategorie des Erstellen-Kanals"><ChannelSelect kinds={['category']} value={c.categoryId} onChange={(v) => m.update((d) => void (d.categoryId = v))} /></Field>
            <Field label="Kanalname" hint="{user} = Anzeigename, {username} = Benutzername"><Input value={c.nameTemplate} maxLength={100} onChange={(e) => m.update((d) => void (d.nameTemplate = e.target.value))} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Standard-Benutzerlimit" hint="0 = unbegrenzt"><NumberInput value={c.defaultLimit} min={0} max={99} onChange={(v) => m.update((d) => void (d.defaultLimit = v))} /></Field>
              <Field label="Löschen nach Leerstand"><NumberInput value={c.deleteDelaySeconds} min={0} max={3600} suffix="Sek." onChange={(v) => m.update((d) => void (d.deleteDelaySeconds = v))} /></Field>
            </div>
          </div>
        </Card>
        <Card>
          <CardHeader title="Besitzerrechte" description="Was Kanalbesitzer mit /voice ändern dürfen" icon={Settings2} />
          <div className="space-y-3 p-5">
            <Switch label="Umbenennen" description="/voice name" checked={c.allowRename} onChange={(v) => m.update((d) => void (d.allowRename = v))} />
            <Switch label="Benutzerlimit setzen" description="/voice limit" checked={c.allowLimit} onChange={(v) => m.update((d) => void (d.allowLimit = v))} />
            <Switch label="Sperren/Entsperren" description="/voice lock · /voice unlock" checked={c.allowLock} onChange={(v) => m.update((d) => void (d.allowLock = v))} />
            <p className="pt-2 text-xs text-fg-subtle">Immer verfügbar: /voice claim, /voice transfer, /voice kick. Der Bot benötigt „Kanäle verwalten“ und „Mitglieder verschieben“.</p>
          </div>
        </Card>
      </div>
      <SaveBar dirty={m.dirty} saving={m.saving} onSave={m.save} onReset={m.reset} />
    </div>
  );
}

export default function VoicePage() {
  const [tab, setTab] = useState<'live' | 'settings'>('live');
  return (
    <>
      <PageHeader title="Voice-Manager" description="Temporäre Sprachkanäle mit Besitzerrechten" icon={Mic} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'live', label: 'Live', icon: Radio }, { id: 'settings', label: 'Einstellungen', icon: Settings2 }]} />
      {tab === 'live' ? <LiveTab /> : <SettingsTab />}
    </>
  );
}
