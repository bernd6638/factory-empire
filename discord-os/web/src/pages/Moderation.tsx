import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, BarChart3, Ban, FileWarning, Gavel, Link2, MailWarning, Plus, RotateCcw, Settings2, ShieldAlert, ShieldCheck, Trash2, Type, Undo2, Users, Zap } from 'lucide-react';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, qs } from '../lib/api';
import { avatarUrl, dateTime, duration, num, relative, shortDay } from '../lib/format';
import type { ModCase, Paged } from '../lib/types';
import type { AutoAction } from '@shared/modules';
import { useCan, useGuildId, useModuleConfig } from '../hooks/guild';
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, LoadingBlock, NumberInput, PageHeader, Pagination, Select, StatCard, Switch, Tabs } from '../components/ui/core';
import { useConfirm, useToast } from '../components/ui/overlay';
import { ChannelSelect, MultiChannelSelect, MultiRoleSelect, TagInput } from '../components/ui/pickers';
import { ModuleToggle, SaveBar } from '../components/ui/module';
import { CHART, ChartTooltip, axisProps } from '../components/ui/chart';
import { CASE_COLOR, CASE_LABEL, ModActionModal } from '../components/shared/ModActionModal';
import { useLive } from '../lib/live';

type Tab = 'cases' | 'stats' | 'automod' | 'settings' | 'bans';
const SOURCE_LABEL = { COMMAND: 'Befehl', DASHBOARD: 'Dashboard', AUTOMOD: 'Auto-Mod', SYSTEM: 'System' } as const;

function CasesTab() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const [source, setSource] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['cases', guildId, page, type, source, q],
    queryFn: () => api.get<Paged<ModCase>>(`/guilds/${guildId}/moderation/cases${qs({ page, type, source, q, limit: 25 })}`),
    placeholderData: (p) => p,
  });
  const revoke = useMutation({
    mutationFn: (n: number) => api.post(`/guilds/${guildId}/moderation/cases/${n}/revoke`),
    onSuccess: () => {
      toast.success('Fall aufgehoben');
      void qc.invalidateQueries({ queryKey: ['cases'] });
    },
    onError: toast.error,
  });
  return (
    <Card>
      <CardHeader
        title="Moderationsfälle"
        description="Alle Aktionen aus Befehlen, Dashboard und Auto-Moderation"
        icon={Gavel}
        actions={
          <>
            <Input placeholder="Grund oder Name …" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} className="w-48" />
            <Select value={type} onChange={(e) => (setType(e.target.value), setPage(1))} className="w-40">
              <option value="">Alle Typen</option>
              {Object.entries(CASE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Select value={source} onChange={(e) => (setSource(e.target.value), setPage(1))} className="w-36">
              <option value="">Alle Quellen</option>
              {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Button variant="primary" icon={Plus} onClick={() => setOpen(true)}>Aktion</Button>
          </>
        }
      />
      {isLoading ? (
        <LoadingBlock />
      ) : error ? (
        <div className="p-5"><ErrorState error={error} onRetry={() => refetch()} /></div>
      ) : !data?.items.length ? (
        <EmptyState icon={ShieldCheck} title="Keine Fälle" description="Hier erscheinen alle Moderationsaktionen." />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-fg-subtle uppercase">
                <tr className="border-b border-line">
                  <th className="px-5 py-3 font-medium">#</th>
                  <th className="px-3 py-3 font-medium">Typ</th>
                  <th className="px-3 py-3 font-medium">Mitglied</th>
                  <th className="px-3 py-3 font-medium">Grund</th>
                  <th className="px-3 py-3 font-medium">Quelle</th>
                  <th className="px-3 py-3 font-medium">Zeit</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id} className="table-row">
                    <td className="px-5 py-3 font-mono text-xs text-fg-muted">{c.caseNumber}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1.5">
                        <Badge color={CASE_COLOR[c.type]}>{CASE_LABEL[c.type]}</Badge>
                        {!c.active && ['WARN', 'BAN', 'TIMEOUT'].includes(c.type) && <Badge>aufgehoben</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <Avatar src={avatarUrl(c.userId, null)} size={24} />
                        <span>{c.userTag ?? c.userId}</span>
                      </div>
                    </td>
                    <td className="max-w-xs px-3 py-3 text-fg-muted">
                      <div className="truncate" title={c.reason ?? ''}>{c.reason ?? '—'}</div>
                      {c.durationSec && <div className="text-xs text-fg-subtle">Dauer: {duration(c.durationSec)}</div>}
                    </td>
                    <td className="px-3 py-3"><Badge color={c.source === 'AUTOMOD' ? 'violet' : 'gray'}>{SOURCE_LABEL[c.source]}</Badge></td>
                    <td className="px-3 py-3 text-xs whitespace-nowrap text-fg-muted" title={dateTime(c.createdAt)}>{relative(c.createdAt)}</td>
                    <td className="px-5 py-3 text-right">
                      {c.active && ['WARN', 'NOTE'].includes(c.type) && (
                        <Button size="sm" variant="ghost" icon={Undo2} onClick={async () => (await confirm({ title: `Fall #${c.caseNumber} aufheben?`, message: 'Die Verwarnung zählt danach nicht mehr für die Eskalation.' })) && revoke.mutate(c.caseNumber)}>
                          Aufheben
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={data.page} total={data.total} limit={data.limit} onChange={setPage} />
        </>
      )}
      <ModActionModal open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}

function StatsTab() {
  const guildId = useGuildId();
  const { data, isLoading } = useQuery({
    queryKey: ['mod-stats', guildId],
    queryFn: () => api.get<{ byType: { type: string; count: number }[]; bySource: { source: string; count: number }[]; series: { date: string; count: number }[]; topModerators: { moderatorId: string; count: number }[]; activeWarnings: number }>(`/guilds/${guildId}/moderation/stats`),
  });
  if (isLoading || !data) return <LoadingBlock />;
  const total = data.byType.reduce((a, b) => a + b.count, 0);
  const auto = data.bySource.find((s) => s.source === 'AUTOMOD')?.count ?? 0;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Aktionen (30 T)" value={num(total)} icon={Gavel} />
        <StatCard label="Davon Auto-Mod" value={num(auto)} icon={Zap} accent="violet" hint={total ? `${Math.round((auto / total) * 100)}%` : undefined} />
        <StatCard label="Aktive Verwarnungen" value={num(data.activeWarnings)} icon={FileWarning} accent="yellow" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Aktionen pro Tag" icon={BarChart3} />
          <div className="h-64 p-4">
            <ResponsiveContainer>
              <BarChart data={data.series}>
                <CartesianGrid stroke={CHART.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={shortDay} {...axisProps} minTickGap={20} />
                <YAxis {...axisProps} width={30} allowDecimals={false} />
                <Tooltip content={<ChartTooltip labelFormatter={shortDay} />} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
                <Bar dataKey="count" name="Aktionen" fill={CHART.red} radius={[4, 4, 0, 0]} maxBarSize={16} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card>
          <CardHeader title="Nach Typ" icon={Gavel} />
          <div className="space-y-3 p-5">
            {data.byType.length === 0 && <p className="text-sm text-fg-subtle">Keine Daten</p>}
            {data.byType.map((t) => (
              <div key={t.type}>
                <div className="mb-1 flex justify-between text-sm"><span>{CASE_LABEL[t.type as ModCase['type']]}</span><span className="text-fg-muted">{t.count}</span></div>
                <div className="h-1.5 overflow-hidden rounded-full bg-panel-3"><div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500" style={{ width: `${(t.count / Math.max(total, 1)) * 100}%` }} /></div>
              </div>
            ))}
            {data.topModerators.length > 0 && (
              <div className="border-t border-line pt-4">
                <div className="label">Aktivste Moderatoren</div>
                {data.topModerators.map((m) => (
                  <div key={m.moderatorId} className="flex items-center justify-between py-1 text-sm"><code className="text-xs text-fg-muted">{m.moderatorId}</code><span>{m.count}</span></div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function ActionEditor({ value, onChange, allowDelete = true }: { value: AutoAction; onChange: (v: AutoAction) => void; allowDelete?: boolean }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Aktion">
        <Select value={value.type} onChange={(e) => onChange({ ...value, type: e.target.value as AutoAction['type'] })}>
          {allowDelete && <option value="delete">Nur löschen</option>}
          <option value="warn">Verwarnen</option>
          <option value="timeout">Timeout</option>
          <option value="kick">Kicken</option>
          <option value="ban">Bannen</option>
        </Select>
      </Field>
      {value.type === 'timeout' && (
        <Field label="Timeout-Dauer">
          <NumberInput value={value.durationMinutes} min={1} max={40320} suffix="Min." onChange={(v) => onChange({ ...value, durationMinutes: v })} />
        </Field>
      )}
      {value.type !== 'delete' && (
        <div className="flex items-end pb-2">
          <Switch label="Nachricht löschen" checked={value.deleteMessage} onChange={(v) => onChange({ ...value, deleteMessage: v })} />
        </div>
      )}
    </div>
  );
}

function RuleCard({ icon: Icon, title, description, enabled, onToggle, children }: { icon: typeof Zap; title: string; description: string; enabled: boolean; onToggle: (v: boolean) => void; children?: React.ReactNode }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="flex items-start gap-3">
          <div className={`rounded-xl p-2.5 ring-1 ${enabled ? 'bg-brand-500/10 text-brand-300 ring-brand-500/25' : 'bg-panel-3 text-fg-subtle ring-line'}`}><Icon className="h-5 w-5" /></div>
          <div>
            <div className="font-medium">{title}</div>
            <div className="text-sm text-fg-muted">{description}</div>
          </div>
        </div>
        <Switch checked={enabled} onChange={onToggle} />
      </div>
      {enabled && children && <div className="space-y-4 border-t border-line/70 px-5 py-4">{children}</div>}
    </Card>
  );
}

function AutomodTab() {
  const guildId = useGuildId();
  const toast = useToast();
  const m = useModuleConfig('automod');
  const { data: raid, refetch } = useQuery({ queryKey: ['raid', guildId], queryFn: () => api.get<{ lockdown: boolean; secondsLeft: number }>(`/guilds/${guildId}/moderation/raid`), refetchInterval: 15_000, retry: false });
  useLive('raid', () => void refetch());
  const endRaid = useMutation({ mutationFn: () => api.post(`/guilds/${guildId}/moderation/raid/end`), onSuccess: () => (toast.success('Raid-Sperre beendet'), void refetch()), onError: toast.error });
  if (m.isLoading || !m.config) return <LoadingBlock />;
  const c = m.config;
  return (
    <div className="space-y-4">
      <ModuleToggle name="Auto-Moderation" enabled={m.enabled} onChange={m.setEnabled} saving={m.saving} />
      {raid?.lockdown && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-5 py-4">
          <div className="flex items-center gap-3 text-red-200"><AlertOctagon className="h-5 w-5" />Raid-Sperre aktiv – noch {Math.ceil(raid.secondsLeft / 60)} Minuten. Neue Mitglieder werden entsprechend der Einstellung behandelt.</div>
          <Button variant="danger" onClick={() => endRaid.mutate()} loading={endRaid.isPending}>Sperre beenden</Button>
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        <RuleCard icon={Zap} title="Spam-Erkennung" description="Nachrichtenflut, Wiederholungen und Massen-Erwähnungen" enabled={c.spam.enabled} onToggle={(v) => m.update((d) => void (d.spam.enabled = v))}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Max. Nachrichten"><NumberInput value={c.spam.maxMessages} min={2} max={50} onChange={(v) => m.update((d) => void (d.spam.maxMessages = v))} /></Field>
            <Field label="Zeitraum"><NumberInput value={c.spam.intervalSeconds} min={1} max={120} suffix="Sek." onChange={(v) => m.update((d) => void (d.spam.intervalSeconds = v))} /></Field>
            <Field label="Gleiche Nachricht ab"><NumberInput value={c.spam.duplicateThreshold} min={2} max={20} suffix="×" onChange={(v) => m.update((d) => void (d.spam.duplicateThreshold = v))} /></Field>
            <Field label="Max. Erwähnungen"><NumberInput value={c.spam.maxMentions} min={1} max={50} onChange={(v) => m.update((d) => void (d.spam.maxMentions = v))} /></Field>
          </div>
          <ActionEditor value={c.spam.action} onChange={(v) => m.update((d) => void (d.spam.action = v))} />
        </RuleCard>

        <RuleCard icon={MailWarning} title="Anti-Invite" description="Blockiert Einladungen zu fremden Discord-Servern" enabled={c.invites.enabled} onToggle={(v) => m.update((d) => void (d.invites.enabled = v))}>
          <Switch label="Eigene Einladungen erlauben" description="Einladungen dieses Servers (benötigt „Server verwalten“ für den Bot)" checked={c.invites.allowOwnInvites} onChange={(v) => m.update((d) => void (d.invites.allowOwnInvites = v))} />
          <ActionEditor value={c.invites.action} onChange={(v) => m.update((d) => void (d.invites.action = v))} />
        </RuleCard>

        <RuleCard icon={Link2} title="Anti-Link" description="Erlaubt nur Links zu freigegebenen Domains" enabled={c.links.enabled} onToggle={(v) => m.update((d) => void (d.links.enabled = v))}>
          <Field label="Erlaubte Domains" hint="Subdomains sind automatisch erlaubt (youtube.com → music.youtube.com)">
            <TagInput value={c.links.allowedDomains} onChange={(v) => m.update((d) => void (d.links.allowedDomains = v))} placeholder="z. B. youtube.com" />
          </Field>
          <ActionEditor value={c.links.action} onChange={(v) => m.update((d) => void (d.links.action = v))} />
        </RuleCard>

        <RuleCard icon={FileWarning} title="Wortfilter" description="Beleidigungen und verbotene Begriffe mit konfigurierbaren Regeln" enabled={c.badwords.enabled} onToggle={(v) => m.update((d) => void (d.badwords.enabled = v))}>
          <Field label="Wörter" hint="„*“ als Platzhalter, z. B. idiot* · Leetspeak (1d10t) wird erkannt">
            <TagInput value={c.badwords.words} onChange={(v) => m.update((d) => void (d.badwords.words = v))} />
          </Field>
          <Field label="Reguläre Ausdrücke (erweitert)" hint="Ohne Schrägstriche, Groß-/Kleinschreibung wird ignoriert">
            <TagInput value={c.badwords.regex} onChange={(v) => m.update((d) => void (d.badwords.regex = v))} placeholder="z. B. sp[a@]m+" />
          </Field>
          <ActionEditor value={c.badwords.action} onChange={(v) => m.update((d) => void (d.badwords.action = v))} />
        </RuleCard>

        <RuleCard icon={Type} title="Großschreibung" description="Nachrichten mit übermäßig vielen Großbuchstaben" enabled={c.caps.enabled} onToggle={(v) => m.update((d) => void (d.caps.enabled = v))}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Mindestlänge"><NumberInput value={c.caps.minLength} min={5} max={500} suffix="Buchst." onChange={(v) => m.update((d) => void (d.caps.minLength = v))} /></Field>
            <Field label="Anteil Großbuchstaben"><NumberInput value={c.caps.percent} min={50} max={100} suffix="%" onChange={(v) => m.update((d) => void (d.caps.percent = v))} /></Field>
          </div>
          <ActionEditor value={c.caps.action} onChange={(v) => m.update((d) => void (d.caps.action = v))} />
        </RuleCard>

        <RuleCard icon={Users} title="Anti-Raid" description="Erkennt Beitrittswellen und neue Konten" enabled={c.raid.enabled} onToggle={(v) => m.update((d) => void (d.raid.enabled = v))}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Beitritte"><NumberInput value={c.raid.joinThreshold} min={3} max={200} onChange={(v) => m.update((d) => void (d.raid.joinThreshold = v))} /></Field>
            <Field label="Innerhalb von"><NumberInput value={c.raid.intervalSeconds} min={5} max={600} suffix="Sek." onChange={(v) => m.update((d) => void (d.raid.intervalSeconds = v))} /></Field>
            <Field label="Aktion bei Raid">
              <Select value={c.raid.action} onChange={(e) => m.update((d) => void (d.raid.action = e.target.value as typeof c.raid.action))}>
                <option value="alert">Nur alarmieren</option>
                <option value="timeout">Timeout (1 Std.)</option>
                <option value="kick">Kicken</option>
                <option value="ban">Bannen</option>
              </Select>
            </Field>
            <Field label="Sperrdauer"><NumberInput value={c.raid.lockdownMinutes} min={1} max={1440} suffix="Min." onChange={(v) => m.update((d) => void (d.raid.lockdownMinutes = v))} /></Field>
            <Field label="Mindestalter des Kontos" hint="0 = deaktiviert"><NumberInput value={c.raid.minAccountAgeDays} min={0} max={365} suffix="Tage" onChange={(v) => m.update((d) => void (d.raid.minAccountAgeDays = v))} /></Field>
            <Field label="Aktion für neue Konten">
              <Select value={c.raid.newAccountAction} onChange={(e) => m.update((d) => void (d.raid.newAccountAction = e.target.value as typeof c.raid.newAccountAction))}>
                <option value="none">Keine</option>
                <option value="timeout">Timeout (1 Std.)</option>
                <option value="kick">Kicken</option>
              </Select>
            </Field>
          </div>
          <Field label="Alarm-Kanal"><ChannelSelect value={c.raid.alertChannelId} onChange={(v) => m.update((d) => void (d.raid.alertChannelId = v))} /></Field>
        </RuleCard>
      </div>

      <Card>
        <CardHeader title="Ausnahmen & Protokoll" icon={Settings2} description="Mitglieder mit „Nachrichten verwalten“ oder Administrator sind immer ausgenommen." />
        <div className="grid gap-4 p-5 lg:grid-cols-3">
          <Field label="Ignorierte Kanäle"><MultiChannelSelect value={c.ignoredChannelIds} onChange={(v) => m.update((d) => void (d.ignoredChannelIds = v))} /></Field>
          <Field label="Ignorierte Rollen"><MultiRoleSelect value={c.ignoredRoleIds} onChange={(v) => m.update((d) => void (d.ignoredRoleIds = v))} /></Field>
          <Field label="Auto-Mod-Protokollkanal"><ChannelSelect value={c.logChannelId} onChange={(v) => m.update((d) => void (d.logChannelId = v))} /></Field>
        </div>
      </Card>
      <SaveBar dirty={m.dirty} saving={m.saving} onSave={m.save} onReset={m.reset} />
    </div>
  );
}

function SettingsTab() {
  const m = useModuleConfig('moderation');
  if (m.isLoading || !m.config) return <LoadingBlock />;
  const c = m.config;
  return (
    <div className="space-y-4">
      <ModuleToggle name="Moderation" enabled={m.enabled} onChange={m.setEnabled} saving={m.saving} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Allgemein" icon={Settings2} />
          <div className="space-y-4 p-5">
            <Switch label="Betroffene per DM informieren" description="Grund und Dauer werden dem Mitglied zugestellt" checked={c.dmOnAction} onChange={(v) => m.update((d) => void (d.dmOnAction = v))} />
            <Switch label="Begründung erforderlich" description="Befehle und Dashboard-Aktionen ohne Grund ablehnen" checked={c.requireReason} onChange={(v) => m.update((d) => void (d.requireReason = v))} />
            <Field label="Moderations-Protokollkanal"><ChannelSelect value={c.logChannelId} onChange={(v) => m.update((d) => void (d.logChannelId = v))} /></Field>
            <Field label="Geschützte Rollen" hint="Mitglieder mit diesen Rollen können nicht moderiert werden (außer vom Besitzer)"><MultiRoleSelect value={c.protectedRoleIds} onChange={(v) => m.update((d) => void (d.protectedRoleIds = v))} /></Field>
            <Field label="Verwarnungen verfallen nach" hint="0 = nie"><NumberInput value={c.warnExpiryDays} min={0} max={3650} suffix="Tagen" onChange={(v) => m.update((d) => void (d.warnExpiryDays = v))} /></Field>
          </div>
        </Card>
        <Card>
          <CardHeader
            title="Automatische Eskalation"
            description="Aktion beim Erreichen einer bestimmten Anzahl aktiver Verwarnungen"
            icon={ShieldAlert}
            actions={<Button size="sm" icon={Plus} disabled={c.escalation.length >= 10} onClick={() => m.update((d) => void d.escalation.push({ warnings: (d.escalation.at(-1)?.warnings ?? 0) + 1, action: 'timeout', durationMinutes: 60 }))}>Stufe</Button>}
          />
          <div className="space-y-3 p-5">
            {c.escalation.length === 0 && <p className="text-sm text-fg-subtle">Keine Eskalationsstufen definiert.</p>}
            {c.escalation.map((e, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-3 rounded-xl border border-line bg-panel-2/50 p-3">
                <Field label="Bei Verwarnungen"><NumberInput value={e.warnings} min={1} max={100} onChange={(v) => m.update((d) => void (d.escalation[i]!.warnings = v))} /></Field>
                <Field label="Aktion">
                  <Select value={e.action} onChange={(ev) => m.update((d) => void (d.escalation[i]!.action = ev.target.value as typeof e.action))}>
                    <option value="timeout">Timeout</option>
                    <option value="kick">Kick</option>
                    <option value="ban">Bann</option>
                  </Select>
                </Field>
                <Field label="Dauer">{e.action === 'timeout' ? <NumberInput value={e.durationMinutes} min={1} max={40320} suffix="Min." onChange={(v) => m.update((d) => void (d.escalation[i]!.durationMinutes = v))} /> : <div className="input text-fg-subtle">—</div>}</Field>
                <Button size="icon" variant="ghost" icon={Trash2} onClick={() => m.update((d) => void d.escalation.splice(i, 1))} />
              </div>
            ))}
          </div>
        </Card>
      </div>
      <SaveBar dirty={m.dirty} saving={m.saving} onSave={m.save} onReset={m.reset} />
    </div>
  );
}

function BansTab() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['bans', guildId], queryFn: () => api.get<{ id: string; username: string; avatar: string; reason: string | null }[]>(`/guilds/${guildId}/moderation/bans`) });
  const unban = useMutation({
    mutationFn: (userId: string) => api.post(`/guilds/${guildId}/moderation/actions`, { type: 'UNBAN', userId, reason: 'Über das Dashboard entbannt' }),
    onSuccess: () => {
      toast.success('Benutzer entbannt');
      void qc.invalidateQueries({ queryKey: ['bans', guildId] });
    },
    onError: toast.error,
  });
  const list = (data ?? []).filter((b) => b.username.toLowerCase().includes(q.toLowerCase()) || b.id.includes(q));
  return (
    <Card>
      <CardHeader title="Gebannte Benutzer" description={data ? `${data.length} Banns` : undefined} icon={Ban} actions={<><Input placeholder="Suchen …" value={q} onChange={(e) => setQ(e.target.value)} className="w-48" /><Button icon={RotateCcw} onClick={() => refetch()} /></>} />
      {isLoading ? <LoadingBlock /> : error ? <div className="p-5"><ErrorState error={error} /></div> : !list.length ? <EmptyState icon={ShieldCheck} title="Keine Banns" /> : (
        <div className="divide-y divide-line/60">
          {list.map((b) => (
            <div key={b.id} className="flex items-center gap-3 px-5 py-3">
              <Avatar src={b.avatar} name={b.username} size={34} />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{b.username}</div>
                <div className="truncate text-xs text-fg-subtle">{b.reason ?? 'Kein Grund'}</div>
              </div>
              <Button size="sm" variant="success" onClick={async () => (await confirm({ title: `${b.username} entbannen?` })) && unban.mutate(b.id)}>Entbannen</Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function ModerationPage() {
  const [tab, setTab] = useState<Tab>('cases');
  const isAdmin = useCan('ADMIN');
  return (
    <>
      <PageHeader title="Moderation" description="Fälle, Auto-Moderation, Eskalation und Banns" icon={ShieldAlert} />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'cases', label: 'Fälle', icon: Gavel },
          { id: 'stats', label: 'Statistik', icon: BarChart3 },
          { id: 'automod', label: 'Auto-Moderation', icon: Zap },
          { id: 'settings', label: 'Einstellungen', icon: Settings2 },
          { id: 'bans', label: 'Banns', icon: Ban },
        ]}
      />
      {tab === 'cases' && <CasesTab />}
      {tab === 'stats' && <StatsTab />}
      {tab === 'automod' && <AutomodTab />}
      {tab === 'settings' && <SettingsTab />}
      {tab === 'bans' && <BansTab />}
      {!isAdmin && (tab === 'automod' || tab === 'settings') && <p className="mt-4 text-center text-xs text-fg-subtle">Nur Administratoren können Einstellungen speichern.</p>}
    </>
  );
}
