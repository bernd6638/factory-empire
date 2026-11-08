import { useMutation, useQuery } from '@tanstack/react-query';
import { Award, Crown, Gift, LineChart as LineIcon, Plus, RefreshCw, Settings2, Trash2, TrendingUp, Trophy } from 'lucide-react';
import { useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../lib/api';
import { num } from '../lib/format';
import { useCan, useGuildId, useModuleConfig } from '../hooks/guild';
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, Field, LoadingBlock, NumberInput, PageHeader, Select, Switch, Tabs, Textarea } from '../components/ui/core';
import { useConfirm, useToast } from '../components/ui/overlay';
import { ChannelSelect, MultiChannelSelect, MultiRoleSelect, RoleSelect } from '../components/ui/pickers';
import { ModuleToggle, SaveBar } from '../components/ui/module';
import { CHART, ChartTooltip, axisProps } from '../components/ui/chart';

interface LeaderRow {
  rank: number;
  userId: string;
  username: string;
  avatarUrl: string;
  xp: number;
  level: number;
  messages: number;
  progress: { percent: number };
}

function Leaderboard() {
  const guildId = useGuildId();
  const [period, setPeriod] = useState<'all' | 'week' | 'month'>('all');
  const { data, isLoading } = useQuery({ queryKey: ['leaderboard', guildId, period], queryFn: () => api.get<LeaderRow[]>(`/guilds/${guildId}/leveling/leaderboard?period=${period}&limit=100`) });
  const podium = (data ?? []).slice(0, 3);
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)} className="w-48">
          <option value="all">Gesamt</option>
          <option value="week">Letzte 7 Tage</option>
          <option value="month">Letzte 30 Tage</option>
        </Select>
      </div>
      {isLoading ? (
        <LoadingBlock />
      ) : !data?.length ? (
        <Card><EmptyState icon={Trophy} title="Noch keine Rangliste" description="Mitglieder sammeln XP durch Nachrichten und Voice-Aktivität." /></Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {podium.map((p, i) => (
              <Card key={p.userId} delay={i * 0.05} className={`relative overflow-hidden p-5 ${i === 0 ? 'ring-1 ring-amber-400/30' : ''}`}>
                <div className={`pointer-events-none absolute -top-10 -right-10 h-32 w-32 rounded-full blur-2xl ${['bg-amber-400/20', 'bg-slate-300/15', 'bg-orange-500/15'][i]}`} />
                <div className="relative flex items-center gap-4">
                  <div className="relative">
                    <Avatar src={p.avatarUrl} name={p.username} size={56} />
                    {i === 0 && <Crown className="absolute -top-3 -right-2 h-6 w-6 rotate-12 text-amber-300" />}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs text-fg-subtle">Platz {i + 1}</div>
                    <div className="truncate font-semibold">{p.username}</div>
                    <div className="mt-1 flex gap-2"><Badge color="violet">Level {p.level}</Badge><Badge>{num(p.xp)} XP</Badge></div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-fg-subtle uppercase">
                  <tr className="border-b border-line"><th className="px-5 py-3 font-medium">Rang</th><th className="px-3 py-3 font-medium">Mitglied</th><th className="px-3 py-3 font-medium">Level</th><th className="px-3 py-3 font-medium">Fortschritt</th><th className="px-3 py-3 font-medium">{period === 'all' ? 'XP gesamt' : 'XP im Zeitraum'}</th><th className="px-5 py-3 font-medium">Nachrichten</th></tr>
                </thead>
                <tbody>
                  {data.map((r) => (
                    <tr key={r.userId} className="table-row">
                      <td className="px-5 py-2.5 font-semibold text-fg-muted">#{r.rank}</td>
                      <td className="px-3 py-2.5"><div className="flex items-center gap-3"><Avatar src={r.avatarUrl} name={r.username} size={30} /><span className="font-medium">{r.username}</span></div></td>
                      <td className="px-3 py-2.5">{r.level}</td>
                      <td className="w-48 px-3 py-2.5"><div className="h-1.5 overflow-hidden rounded-full bg-panel-3"><div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500" style={{ width: `${r.progress.percent}%` }} /></div></td>
                      <td className="px-3 py-2.5 tabular-nums">{num(r.xp)}</td>
                      <td className="px-5 py-2.5 text-fg-muted tabular-nums">{num(r.messages)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Settings() {
  const guildId = useGuildId();
  const m = useModuleConfig('leveling');
  const c = m.config;
  const { data: preview } = useQuery({
    queryKey: ['curve', guildId, JSON.stringify(c?.curve)],
    queryFn: () => api.post<{ level: number; xpForLevel: number; totalXp: number }[]>(`/guilds/${guildId}/leveling/curve-preview`, { curve: c?.curve }),
    enabled: !!c,
    placeholderData: (p) => p,
  });
  if (m.isLoading || !c) return <LoadingBlock />;
  return (
    <div className="space-y-4">
      <ModuleToggle name="Level & XP" enabled={m.enabled} onChange={m.setEnabled} saving={m.saving} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="XP-Vergabe" icon={TrendingUp} />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="XP pro Nachricht (min.)"><NumberInput value={c.xpMin} min={0} max={1000} onChange={(v) => m.update((d) => void (d.xpMin = v))} /></Field>
            <Field label="XP pro Nachricht (max.)"><NumberInput value={c.xpMax} min={0} max={1000} onChange={(v) => m.update((d) => void (d.xpMax = v))} /></Field>
            <Field label="Cooldown" hint="Nur eine XP-Vergabe pro Zeitraum"><NumberInput value={c.cooldownSeconds} min={0} max={3600} suffix="Sek." onChange={(v) => m.update((d) => void (d.cooldownSeconds = v))} /></Field>
            <Field label="Globaler Multiplikator"><NumberInput value={c.globalMultiplier} min={0} max={10} step={0.1} suffix="×" onChange={(v) => m.update((d) => void (d.globalMultiplier = v))} /></Field>
            <div className="sm:col-span-2">
              <Switch label="Voice-XP" description="XP pro Minute im Sprachkanal (mind. 2 Personen, nicht taub geschaltet)" checked={c.voiceXp.enabled} onChange={(v) => m.update((d) => void (d.voiceXp.enabled = v))} />
            </div>
            {c.voiceXp.enabled && <Field label="XP pro Voice-Minute"><NumberInput value={c.voiceXp.xpPerMinute} min={0} max={100} onChange={(v) => m.update((d) => void (d.voiceXp.xpPerMinute = v))} /></Field>}
          </div>
        </Card>
        <Card>
          <CardHeader title="Levelkurve" description="Bei Änderung werden alle Level automatisch neu berechnet." icon={LineIcon} />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Kurventyp">
              <Select value={c.curve.type} onChange={(e) => m.update((d) => void (d.curve.type = e.target.value as typeof c.curve.type))}>
                <option value="standard">Standard (5·L² + 50·L + 100)</option>
                <option value="linear">Linear</option>
                <option value="exponential">Exponentiell</option>
              </Select>
            </Field>
            <Field label={c.curve.type === 'standard' ? 'Skalierung (100 = normal)' : 'Basis-XP'}><NumberInput value={c.curve.base} min={10} max={100000} onChange={(v) => m.update((d) => void (d.curve.base = v))} /></Field>
            {c.curve.type === 'linear' && <Field label="Zuwachs pro Level"><NumberInput value={c.curve.step} min={0} max={100000} onChange={(v) => m.update((d) => void (d.curve.step = v))} /></Field>}
            {c.curve.type === 'exponential' && <Field label="Wachstumsfaktor"><NumberInput value={c.curve.growth} min={1.01} max={3} step={0.01} suffix="×" onChange={(v) => m.update((d) => void (d.curve.growth = v))} /></Field>}
          </div>
          <div className="h-48 px-3 pb-4">
            <ResponsiveContainer>
              <LineChart data={preview ?? []}>
                <CartesianGrid stroke={CHART.grid} vertical={false} />
                <XAxis dataKey="level" {...axisProps} />
                <YAxis {...axisProps} width={56} tickFormatter={(v) => num(v)} />
                <Tooltip content={<ChartTooltip labelFormatter={(l) => `Level ${l}`} />} />
                <Line dataKey="totalXp" name="Gesamt-XP" stroke={CHART.violet} strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card>
          <CardHeader title="Level-Up-Nachricht" icon={Award} />
          <div className="space-y-4 p-5">
            <Switch label="Level-Up ankündigen" checked={c.levelUp.enabled} onChange={(v) => m.update((d) => void (d.levelUp.enabled = v))} />
            <Field label="Kanal" hint="Leer = im Kanal der Nachricht"><ChannelSelect value={c.levelUp.channelId} onChange={(v) => m.update((d) => void (d.levelUp.channelId = v))} placeholder="Gleicher Kanal" /></Field>
            <Field label="Nachricht" hint="Platzhalter: {user} {username} {level} {server}"><Textarea value={c.levelUp.message} maxLength={1000} onChange={(e) => m.update((d) => void (d.levelUp.message = e.target.value))} /></Field>
          </div>
        </Card>
        <Card>
          <CardHeader title="Multiplikatoren & Ausnahmen" icon={Settings2} />
          <div className="space-y-4 p-5">
            <MultiplierList label="Rollen-Multiplikatoren" items={c.roleMultipliers.map((r) => ({ id: r.roleId, multiplier: r.multiplier }))} kind="role" onChange={(items) => m.update((d) => void (d.roleMultipliers = items.map((i) => ({ roleId: i.id, multiplier: i.multiplier }))))} />
            <MultiplierList label="Kanal-Multiplikatoren" items={c.channelMultipliers.map((r) => ({ id: r.channelId, multiplier: r.multiplier }))} kind="channel" onChange={(items) => m.update((d) => void (d.channelMultipliers = items.map((i) => ({ channelId: i.id, multiplier: i.multiplier }))))} />
            <Field label="Keine XP in Kanälen"><MultiChannelSelect kinds={['text', 'voice', 'category']} value={c.ignoredChannelIds} onChange={(v) => m.update((d) => void (d.ignoredChannelIds = v))} /></Field>
            <Field label="Keine XP für Rollen"><MultiRoleSelect value={c.ignoredRoleIds} onChange={(v) => m.update((d) => void (d.ignoredRoleIds = v))} /></Field>
          </div>
        </Card>
      </div>
      <SaveBar dirty={m.dirty} saving={m.saving} onSave={m.save} onReset={m.reset} />
    </div>
  );
}

function MultiplierList({ label, items, kind, onChange }: { label: string; items: { id: string; multiplier: number }[]; kind: 'role' | 'channel'; onChange: (items: { id: string; multiplier: number }[]) => void }) {
  const [pick, setPick] = useState<string | null>(null);
  return (
    <div>
      <div className="label">{label}</div>
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={it.id} className="flex items-center gap-2">
            <div className="flex-1">{kind === 'role' ? <RoleSelect value={it.id} onChange={() => undefined} allowClear={false} /> : <ChannelSelect value={it.id} onChange={() => undefined} allowClear={false} />}</div>
            <NumberInput value={it.multiplier} min={0} max={10} step={0.1} suffix="×" className="w-28" onChange={(v) => onChange(items.map((x, j) => (j === i ? { ...x, multiplier: v } : x)))} />
            <Button size="icon" variant="ghost" icon={Trash2} onClick={() => onChange(items.filter((_, j) => j !== i))} />
          </div>
        ))}
        <div className="flex gap-2">
          <div className="flex-1">{kind === 'role' ? <RoleSelect value={pick} onChange={setPick} placeholder="Rolle hinzufügen …" /> : <ChannelSelect value={pick} onChange={setPick} placeholder="Kanal hinzufügen …" />}</div>
          <Button icon={Plus} disabled={!pick || items.some((i) => i.id === pick)} onClick={() => pick && (onChange([...items, { id: pick, multiplier: 1.5 }]), setPick(null))} />
        </div>
      </div>
    </div>
  );
}

function Rewards() {
  const guildId = useGuildId();
  const toast = useToast();
  const confirm = useConfirm();
  const isAdmin = useCan('ADMIN');
  const m = useModuleConfig('leveling');
  const sync = useMutation({ mutationFn: () => api.post<{ updated: number }>(`/guilds/${guildId}/leveling/sync-roles`), onSuccess: (r) => toast.success(`Levelrollen für ${r.updated} Mitglieder geprüft`), onError: toast.error });
  const reset = useMutation({ mutationFn: () => api.post<{ reset: number }>(`/guilds/${guildId}/leveling/reset`), onSuccess: (r) => toast.success(`XP von ${r.reset} Mitgliedern zurückgesetzt`), onError: toast.error });
  if (m.isLoading || !m.config) return <LoadingBlock />;
  const c = m.config;
  const sorted = c.rewards.map((r, i) => ({ ...r, i })).sort((a, b) => a.level - b.level);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Level-Belohnungen"
          description="Rollen und Economy-Coins beim Erreichen eines Levels"
          icon={Gift}
          actions={
            <>
              {isAdmin && <Button icon={RefreshCw} loading={sync.isPending} onClick={() => sync.mutate()}>Rollen synchronisieren</Button>}
              <Button variant="primary" icon={Plus} disabled={c.rewards.length >= 100} onClick={() => m.update((d) => void d.rewards.push({ level: (d.rewards.at(-1)?.level ?? 0) + 5, roleId: null, coins: 0 }))}>Belohnung</Button>
            </>
          }
        />
        <div className="space-y-3 p-5">
          {sorted.length === 0 && <EmptyState icon={Gift} title="Keine Belohnungen" description="Füge Levelrollen oder Coin-Belohnungen hinzu." />}
          {sorted.map((r) => (
            <div key={r.i} className="grid items-end gap-3 rounded-xl border border-line bg-panel-2/50 p-3 sm:grid-cols-[120px_1fr_160px_auto]">
              <Field label="Level"><NumberInput value={r.level} min={1} max={1000} onChange={(v) => m.update((d) => void (d.rewards[r.i]!.level = v))} /></Field>
              <Field label="Rolle"><RoleSelect assignable value={r.roleId} onChange={(v) => m.update((d) => void (d.rewards[r.i]!.roleId = v))} placeholder="Keine Rolle" /></Field>
              <Field label="Coins (Economy)"><NumberInput value={r.coins} min={0} max={1000000} onChange={(v) => m.update((d) => void (d.rewards[r.i]!.coins = v))} /></Field>
              <Button size="icon" variant="ghost" icon={Trash2} onClick={() => m.update((d) => void d.rewards.splice(r.i, 1))} />
            </div>
          ))}
          <div className="pt-2">
            <Switch label="Belohnungsrollen stapeln" description="Aus: Mitglieder behalten nur die höchste erreichte Levelrolle" checked={c.stackRewards} onChange={(v) => m.update((d) => void (d.stackRewards = v))} />
          </div>
        </div>
      </Card>
      {isAdmin && (
        <Card>
          <CardHeader title="Gefahrenzone" icon={Trash2} />
          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-sm text-fg-muted">Setzt XP und Level aller Mitglieder auf 0 zurück. Kann nicht rückgängig gemacht werden.</p>
            <Button variant="danger" loading={reset.isPending} onClick={async () => (await confirm({ title: 'Alle XP zurücksetzen?', danger: true, typeToConfirm: 'zurücksetzen', confirmLabel: 'Zurücksetzen' })) && reset.mutate()}>Alle XP zurücksetzen</Button>
          </div>
        </Card>
      )}
      <SaveBar dirty={m.dirty} saving={m.saving} onSave={m.save} onReset={m.reset} />
    </div>
  );
}

export default function LevelingPage() {
  const [tab, setTab] = useState<'board' | 'settings' | 'rewards'>('board');
  return (
    <>
      <PageHeader title="Level & XP" description="Ranglisten, Levelkurven, Multiplikatoren und Belohnungen" icon={TrendingUp} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'board', label: 'Rangliste', icon: Trophy }, { id: 'settings', label: 'Einstellungen', icon: Settings2 }, { id: 'rewards', label: 'Belohnungen', icon: Gift }]} />
      {tab === 'board' && <Leaderboard />}
      {tab === 'settings' && <Settings />}
      {tab === 'rewards' && <Rewards />}
    </>
  );
}
