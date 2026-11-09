import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, ArrowDown, Bell, CalendarClock, CheckCircle2, Clock, FlaskConical, HandHeart, Pencil, Play, Plus, Settings2, Trash2, Workflow, XCircle, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AutomationAction, TriggerType } from '@shared/automation';
import { api } from '../lib/api';
import { dateTime, relative } from '../lib/format';
import { useCan, useGuildId, useLookup, useModuleConfig } from '../hooks/guild';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, LoadingBlock, NumberInput, PageHeader, Select, Switch, Tabs, Textarea } from '../components/ui/core';
import { Modal, useConfirm, useToast } from '../components/ui/overlay';
import { ChannelSelect, MultiChannelSelect, MultiRoleSelect, RoleSelect, TagInput } from '../components/ui/pickers';
import { ModuleToggle, SaveBar } from '../components/ui/module';

interface Rule {
  id: number;
  name: string;
  enabled: boolean;
  trigger: TriggerType;
  triggerConfig: Record<string, any>;
  conditions: { ignoreBots: boolean; requiredRoleIds: string[]; excludedRoleIds: string[] };
  actions: AutomationAction[];
  runCount: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
}

const TRIGGERS: Record<TriggerType, { label: string; description: string }> = {
  MEMBER_JOIN: { label: 'Mitglied tritt bei', description: 'Wenn jemand dem Server beitritt' },
  MEMBER_LEAVE: { label: 'Mitglied verlässt', description: 'Wenn jemand den Server verlässt' },
  MESSAGE_CONTAINS: { label: 'Nachricht enthält', description: 'Wenn eine Nachricht bestimmte Wörter enthält' },
  REACTION_ADD: { label: 'Reaktion', description: 'Wenn jemand mit einem Emoji reagiert' },
  ROLE_ADDED: { label: 'Rolle erhalten', description: 'Wenn ein Mitglied eine bestimmte Rolle bekommt' },
  LEVEL_UP: { label: 'Level erreicht', description: 'Wenn ein Mitglied ein Level erreicht (Leveling-Modul)' },
  SCHEDULE: { label: 'Zeitplan', description: 'Zu festen Zeiten (Cron-Ausdruck)' },
  INACTIVITY: { label: 'Inaktivität', description: 'Wenn ein Mitglied X Tage nicht geschrieben hat' },
};

const ACTIONS: Record<AutomationAction['type'], string> = {
  SEND_MESSAGE: 'Nachricht senden',
  SEND_POLL: 'Umfrage senden',
  REPLY: 'Auf Nachricht antworten',
  SEND_DM: 'Direktnachricht senden',
  ADD_ROLE: 'Rolle hinzufügen',
  REMOVE_ROLE: 'Rolle entfernen',
  ADD_REACTION: 'Reaktion hinzufügen',
  DELETE_MESSAGE: 'Nachricht löschen',
  TIMEOUT: 'Timeout vergeben',
};

/** Vorlage: alle 3 Monate (1. Jan/Apr/Jul/Okt, 18 Uhr) eine Umfrage zur RAD-Wahl */
const PRESET_QUARTERLY_POLL: Partial<Rule> = {
  name: 'RAD-Abstimmung (alle 3 Monate)',
  enabled: true,
  trigger: 'SCHEDULE',
  triggerConfig: { cron: '0 18 1 1,4,7,10 *' },
  conditions: { ignoreBots: true, requiredRoleIds: [], excludedRoleIds: [] },
  actions: [
    {
      type: 'SEND_POLL',
      channelId: null,
      content: '📢 Die neue RAD-Wahl startet! Stimmt bis nächste Woche ab.',
      question: 'Wer möchte in den RAD?',
      answers: [
        { text: 'Ich', emoji: '✅' },
        { text: 'Ich nicht', emoji: '❌' },
      ],
      durationHours: 168,
      allowMultiselect: false,
      delaySeconds: 0,
    },
  ],
};

const CRON_PRESETS = [
  { label: 'Alle 3 Monate (1. Jan/Apr/Jul/Okt, 18 Uhr)', cron: '0 18 1 1,4,7,10 *' },
  { label: 'Täglich 9:00', cron: '0 9 * * *' },
  { label: 'Montags 18:00', cron: '0 18 * * 1' },
  { label: 'Stündlich', cron: '0 * * * *' },
  { label: 'Jeden 1. des Monats', cron: '0 12 1 * *' },
];

function defaultAction(type: AutomationAction['type']): AutomationAction {
  switch (type) {
    case 'SEND_MESSAGE':
      return { type, channelId: null, content: 'Hallo {user}!', embed: false, color: '#6366f1', delaySeconds: 0 };
    case 'SEND_POLL':
      return { type, channelId: null, content: '', question: 'Deine Frage?', answers: [{ text: 'Ja', emoji: '✅' }, { text: 'Nein', emoji: '❌' }], durationHours: 168, allowMultiselect: false, delaySeconds: 0 };
    case 'REPLY':
    case 'SEND_DM':
      return { type, content: 'Hallo {user}!', delaySeconds: 0 };
    case 'ADD_ROLE':
    case 'REMOVE_ROLE':
      return { type, roleId: '', delaySeconds: 0 } as AutomationAction;
    case 'ADD_REACTION':
      return { type, emoji: '👍', delaySeconds: 0 };
    case 'DELETE_MESSAGE':
      return { type, delaySeconds: 0 };
    case 'TIMEOUT':
      return { type, minutes: 10, reason: 'Automatisierung', delaySeconds: 0 };
  }
}

function defaultTriggerConfig(t: TriggerType): Record<string, any> {
  switch (t) {
    case 'MESSAGE_CONTAINS':
      return { keywords: [], matchMode: 'contains', caseSensitive: false, channelIds: [] };
    case 'REACTION_ADD':
      return { messageId: null, emoji: '' };
    case 'ROLE_ADDED':
      return { roleId: '' };
    case 'LEVEL_UP':
      return { level: null };
    case 'SCHEDULE':
      return { cron: '0 9 * * *' };
    case 'INACTIVITY':
      return { days: 30 };
    default:
      return {};
  }
}

const MESSAGE_ONLY = new Set(['REPLY', 'ADD_REACTION', 'DELETE_MESSAGE']);
const MEMBER_ACTIONS = new Set(['ADD_ROLE', 'REMOVE_ROLE', 'TIMEOUT', 'SEND_DM']);

function ActionFields({ action, onChange, trigger }: { action: AutomationAction; onChange: (a: AutomationAction) => void; trigger: TriggerType }) {
  const missingChannel = trigger === 'SCHEDULE' && (action.type === 'SEND_MESSAGE' || action.type === 'SEND_POLL') && !action.channelId;
  const warn = (MESSAGE_ONLY.has(action.type) && !['MESSAGE_CONTAINS', 'REACTION_ADD'].includes(trigger)) || (MEMBER_ACTIONS.has(action.type) && trigger === 'SCHEDULE') || (['ADD_ROLE', 'REMOVE_ROLE', 'TIMEOUT'].includes(action.type) && trigger === 'MEMBER_LEAVE');
  return (
    <div className="space-y-3">
      {action.type === 'SEND_MESSAGE' && (
        <>
          <Field label="Kanal" hint={trigger === 'SCHEDULE' ? 'Für Zeitpläne erforderlich' : 'Leer = Kanal des Ereignisses'}>
            <ChannelSelect value={action.channelId} onChange={(v) => onChange({ ...action, channelId: v })} />
          </Field>
          <Field label="Nachricht"><Textarea value={action.content} maxLength={2000} onChange={(e) => onChange({ ...action, content: e.target.value })} /></Field>
          <div className="flex flex-wrap items-center gap-4">
            <Switch label="Als Embed" checked={action.embed} onChange={(v) => onChange({ ...action, embed: v })} />
            {action.embed && <input type="color" value={action.color} onChange={(e) => onChange({ ...action, color: e.target.value })} className="h-9 w-12 rounded-lg border border-line bg-panel-2" />}
          </div>
        </>
      )}
      {action.type === 'SEND_POLL' && (
        <>
          <Field label="Kanal" hint={trigger === 'SCHEDULE' ? 'Für Zeitpläne erforderlich' : 'Leer = Kanal des Ereignisses'}>
            <ChannelSelect value={action.channelId} onChange={(v) => onChange({ ...action, channelId: v })} />
          </Field>
          <Field label="Text über der Umfrage (optional)" hint="z. B. eine Rollen-Erwähnung wie <@&ROLLEN-ID> oder @everyone">
            <Input value={action.content} maxLength={2000} onChange={(e) => onChange({ ...action, content: e.target.value })} />
          </Field>
          <Field label="Frage"><Input value={action.question} maxLength={300} onChange={(e) => onChange({ ...action, question: e.target.value })} /></Field>
          <div>
            <div className="label">Antworten (2–10)</div>
            <div className="space-y-2">
              {action.answers.map((a, i) => (
                <div key={i} className="grid grid-cols-[70px_1fr_auto] gap-2">
                  <Input value={a.emoji} placeholder="Emoji" maxLength={64} onChange={(e) => onChange({ ...action, answers: action.answers.map((x, j) => (j === i ? { ...x, emoji: e.target.value } : x)) })} />
                  <Input value={a.text} maxLength={55} onChange={(e) => onChange({ ...action, answers: action.answers.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
                  <Button size="icon" variant="ghost" icon={Trash2} disabled={action.answers.length <= 2} onClick={() => onChange({ ...action, answers: action.answers.filter((_, j) => j !== i) })} />
                </div>
              ))}
              {action.answers.length < 10 && <Button size="sm" icon={Plus} onClick={() => onChange({ ...action, answers: [...action.answers, { text: 'Antwort', emoji: '' }] })}>Antwort</Button>}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Laufzeit" hint="Max. 768 Std. (32 Tage)"><NumberInput value={action.durationHours} min={1} max={768} suffix="Std." onChange={(v) => onChange({ ...action, durationHours: v })} /></Field>
            <div className="flex items-end pb-2"><Switch label="Mehrfachauswahl" checked={action.allowMultiselect} onChange={(v) => onChange({ ...action, allowMultiselect: v })} /></div>
          </div>
        </>
      )}
      {(action.type === 'REPLY' || action.type === 'SEND_DM') && <Field label="Nachricht"><Textarea value={action.content} maxLength={2000} onChange={(e) => onChange({ ...action, content: e.target.value })} /></Field>}
      {(action.type === 'ADD_ROLE' || action.type === 'REMOVE_ROLE') && <Field label="Rolle"><RoleSelect assignable value={action.roleId || null} onChange={(v) => onChange({ ...action, roleId: v ?? '' })} /></Field>}
      {action.type === 'ADD_REACTION' && <Field label="Emoji" hint="Unicode-Emoji oder Server-Emoji im Format <:name:id>"><Input value={action.emoji} onChange={(e) => onChange({ ...action, emoji: e.target.value })} /></Field>}
      {action.type === 'TIMEOUT' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Dauer"><NumberInput value={action.minutes} min={1} max={40320} suffix="Min." onChange={(v) => onChange({ ...action, minutes: v })} /></Field>
          <Field label="Grund"><Input value={action.reason} maxLength={400} onChange={(e) => onChange({ ...action, reason: e.target.value })} /></Field>
        </div>
      )}
      <Field label="Verzögerung" hint="Wartezeit vor dieser Aktion (max. 15 Min.)"><NumberInput value={action.delaySeconds} min={0} max={900} suffix="Sek." onChange={(v) => onChange({ ...action, delaySeconds: v } as AutomationAction)} /></Field>
      {missingChannel && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">Bitte einen Kanal wählen – bei Zeitplänen gibt es keinen „Kanal des Ereignisses“.</p>}
      {warn && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">Diese Aktion passt nicht zum gewählten Auslöser und wird voraussichtlich fehlschlagen.</p>}
    </div>
  );
}

function RuleEditor({ rule, onClose }: { rule: Partial<Rule> | null; onClose: () => void }) {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const [r, setR] = useState<Omit<Rule, 'id' | 'runCount' | 'lastRunAt' | 'nextRunAt' | 'lastError'> & { id?: number }>(() => ({
    id: rule?.id,
    name: rule?.name ?? 'Neue Automatisierung',
    enabled: rule?.enabled ?? true,
    trigger: rule?.trigger ?? 'MEMBER_JOIN',
    triggerConfig: rule?.triggerConfig ?? {},
    conditions: rule?.conditions ?? { ignoreBots: true, requiredRoleIds: [], excludedRoleIds: [] },
    actions: rule?.actions ?? [defaultAction('SEND_MESSAGE')],
  }));
  const [newAction, setNewAction] = useState<AutomationAction['type']>('SEND_MESSAGE');
  const save = useMutation({
    mutationFn: () => {
      const body = { name: r.name, enabled: r.enabled, trigger: r.trigger, triggerConfig: r.triggerConfig, conditions: r.conditions, actions: r.actions };
      return r.id ? api.put(`/guilds/${guildId}/automations/${r.id}`, body) : api.post(`/guilds/${guildId}/automations`, body);
    },
    onSuccess: () => {
      toast.success('Automatisierung gespeichert');
      void qc.invalidateQueries({ queryKey: ['automations'] });
      onClose();
    },
    onError: toast.error,
  });
  const tc = r.triggerConfig;
  const setTc = (patch: Record<string, any>) => setR({ ...r, triggerConfig: { ...tc, ...patch } });

  return (
    <Modal open onClose={onClose} size="lg" title={r.id ? 'Automatisierung bearbeiten' : 'Neue Automatisierung'} footer={<><Button variant="ghost" onClick={onClose}>Abbrechen</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Speichern</Button></>}>
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <Field label="Name"><Input value={r.name} maxLength={100} onChange={(e) => setR({ ...r, name: e.target.value })} /></Field>
          <div className="flex items-end pb-2"><Switch label="Aktiv" checked={r.enabled} onChange={(v) => setR({ ...r, enabled: v })} /></div>
        </div>

        <section>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Zap className="h-4 w-4 text-brand-300" /> 1. Auslöser</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(TRIGGERS) as TriggerType[]).map((t) => (
              <button key={t} onClick={() => setR({ ...r, trigger: t, triggerConfig: defaultTriggerConfig(t) })} className={`rounded-xl border p-3 text-left transition ${r.trigger === t ? 'border-brand-500/60 bg-brand-500/10' : 'border-line bg-panel-2/50 hover:border-line-strong'}`}>
                <div className="text-sm font-medium">{TRIGGERS[t].label}</div>
                <div className="text-xs text-fg-subtle">{TRIGGERS[t].description}</div>
              </button>
            ))}
          </div>
          <div className="mt-4 space-y-3">
            {r.trigger === 'MESSAGE_CONTAINS' && (
              <>
                <Field label="Wörter / Ausdrücke"><TagInput value={tc.keywords ?? []} onChange={(v) => setTc({ keywords: v })} /></Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Vergleich">
                    <Select value={tc.matchMode ?? 'contains'} onChange={(e) => setTc({ matchMode: e.target.value })}>
                      <option value="contains">Enthält</option>
                      <option value="exact">Exakt</option>
                      <option value="startsWith">Beginnt mit</option>
                      <option value="regex">Regulärer Ausdruck</option>
                    </Select>
                  </Field>
                  <div className="flex items-end pb-2"><Switch label="Groß-/Kleinschreibung beachten" checked={!!tc.caseSensitive} onChange={(v) => setTc({ caseSensitive: v })} /></div>
                </div>
                <Field label="Nur in Kanälen" hint="Leer = alle Kanäle"><MultiChannelSelect value={tc.channelIds ?? []} onChange={(v) => setTc({ channelIds: v })} /></Field>
              </>
            )}
            {r.trigger === 'REACTION_ADD' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Nachrichten-ID" hint="Leer = alle Nachrichten"><Input value={tc.messageId ?? ''} onChange={(e) => setTc({ messageId: e.target.value || null })} placeholder="123456789012345678" /></Field>
                <Field label="Emoji" hint="Leer = jedes Emoji"><Input value={tc.emoji ?? ''} onChange={(e) => setTc({ emoji: e.target.value })} placeholder="✅" /></Field>
              </div>
            )}
            {r.trigger === 'ROLE_ADDED' && <Field label="Rolle"><RoleSelect value={tc.roleId || null} onChange={(v) => setTc({ roleId: v ?? '' })} /></Field>}
            {r.trigger === 'LEVEL_UP' && <Field label="Level" hint="Leer = bei jedem Level-Up"><Input type="number" min={1} value={tc.level ?? ''} onChange={(e) => setTc({ level: e.target.value ? Number(e.target.value) : null })} /></Field>}
            {r.trigger === 'SCHEDULE' && (
              <>
                <Field label="Cron-Ausdruck" hint="Minute Stunde Tag Monat Wochentag – Zeitzone aus den Einstellungen"><Input value={tc.cron ?? ''} onChange={(e) => setTc({ cron: e.target.value })} className="font-mono" /></Field>
                <div className="flex flex-wrap gap-2">{CRON_PRESETS.map((p) => <Button key={p.cron} size="sm" variant="ghost" onClick={() => setTc({ cron: p.cron })}>{p.label}</Button>)}</div>
              </>
            )}
            {r.trigger === 'INACTIVITY' && <Field label="Inaktiv seit" hint="Wird stündlich geprüft; jedes Mitglied löst die Regel einmal beim Überschreiten aus."><NumberInput value={tc.days ?? 30} min={1} max={365} suffix="Tagen" onChange={(v) => setTc({ days: v })} /></Field>}
          </div>
        </section>

        {r.trigger !== 'SCHEDULE' && (
          <section>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Settings2 className="h-4 w-4 text-brand-300" /> 2. Bedingungen</div>
            <div className="space-y-3 rounded-xl border border-line p-4">
              <Switch label="Bots ignorieren" checked={r.conditions.ignoreBots} onChange={(v) => setR({ ...r, conditions: { ...r.conditions, ignoreBots: v } })} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Nur mit einer dieser Rollen"><MultiRoleSelect value={r.conditions.requiredRoleIds} onChange={(v) => setR({ ...r, conditions: { ...r.conditions, requiredRoleIds: v } })} /></Field>
                <Field label="Nicht mit diesen Rollen"><MultiRoleSelect value={r.conditions.excludedRoleIds} onChange={(v) => setR({ ...r, conditions: { ...r.conditions, excludedRoleIds: v } })} /></Field>
              </div>
            </div>
          </section>
        )}

        <section>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Play className="h-4 w-4 text-brand-300" /> {r.trigger === 'SCHEDULE' ? '2' : '3'}. Aktionen</div>
          <div className="space-y-3">
            {r.actions.map((a, i) => (
              <div key={i}>
                {i > 0 && <div className="flex justify-center py-1"><ArrowDown className="h-4 w-4 text-fg-subtle" /></div>}
                <div className="rounded-xl border border-line bg-panel-2/40 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <Badge color="brand">{i + 1}. {ACTIONS[a.type]}</Badge>
                    <Button size="icon" variant="ghost" icon={Trash2} disabled={r.actions.length <= 1} onClick={() => setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })} />
                  </div>
                  <ActionFields action={a} trigger={r.trigger} onChange={(na) => setR({ ...r, actions: r.actions.map((x, j) => (j === i ? na : x)) })} />
                </div>
              </div>
            ))}
            {r.actions.length < 10 && (
              <div className="flex gap-2">
                <Select value={newAction} onChange={(e) => setNewAction(e.target.value as AutomationAction['type'])} className="flex-1">
                  {Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
                <Button icon={Plus} onClick={() => setR({ ...r, actions: [...r.actions, defaultAction(newAction)] })}>Aktion</Button>
              </div>
            )}
          </div>
          <p className="mt-3 text-xs text-fg-subtle">Platzhalter: {'{user} {username} {userId} {server} {memberCount} {channel} {level} {days} {date}'}</p>
        </section>
      </div>
    </Modal>
  );
}

function RulesTab() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const isAdmin = useCan('ADMIN');
  const [params, setParams] = useSearchParams();
  const [edit, setEdit] = useState<Partial<Rule> | null | undefined>(params.get('new') ? null : undefined);
  useEffect(() => {
    if (params.get('new')) {
      setEdit(null);
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);
  const { data, isLoading } = useQuery({ queryKey: ['automations', guildId], queryFn: () => api.get<Rule[]>(`/guilds/${guildId}/automations`) });
  const toggle = useMutation({ mutationFn: (id: number) => api.post(`/guilds/${guildId}/automations/${id}/toggle`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['automations'] }), onError: toast.error });
  const del = useMutation({ mutationFn: (id: number) => api.del(`/guilds/${guildId}/automations/${id}`), onSuccess: () => (toast.success('Gelöscht'), void qc.invalidateQueries({ queryKey: ['automations'] })), onError: toast.error });
  const test = useMutation({
    mutationFn: (id: number) => api.post<{ ok: boolean; error: string | null }>(`/guilds/${guildId}/automations/${id}/test`),
    onSuccess: (r) => (r.ok ? toast.success('Testlauf erfolgreich ausgeführt') : toast.error(new Error(`Testlauf mit Fehlern: ${r.error}`)), void qc.invalidateQueries({ queryKey: ['automations'] })),
    onError: toast.error,
  });
  return (
    <>
      <div className="mb-4 flex flex-wrap justify-end gap-2">
        {isAdmin && <Button icon={CalendarClock} onClick={() => setEdit(PRESET_QUARTERLY_POLL)}>Vorlage: RAD-Abstimmung</Button>}
        {isAdmin && <Button variant="primary" icon={Plus} onClick={() => setEdit(null)}>Neue Automatisierung</Button>}
      </div>
      {isLoading ? <LoadingBlock /> : !data?.length ? (
        <Card><EmptyState icon={Workflow} title="Noch keine Automatisierungen" description="Begrüße neue Mitglieder, vergib Rollen, veröffentliche Nachrichten nach Zeitplan oder reagiere auf Schlüsselwörter." action={isAdmin && <Button variant="primary" icon={Plus} onClick={() => setEdit(null)}>Erste Regel erstellen</Button>} /></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.map((rule, i) => (
            <Card key={rule.id} delay={i * 0.03} className={rule.enabled ? '' : 'opacity-70'}>
              <div className="flex items-start justify-between gap-3 px-5 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{rule.name}</span>
                    {rule.lastError ? <XCircle className="h-4 w-4 shrink-0 text-red-400" /> : rule.runCount > 0 ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" /> : null}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                    <Badge color="violet"><Zap className="h-3 w-3" />{TRIGGERS[rule.trigger].label}</Badge>
                    <span className="text-fg-subtle">→</span>
                    {rule.actions.map((a, j) => <Badge key={j}>{ACTIONS[a.type]}</Badge>)}
                  </div>
                </div>
                <Switch checked={rule.enabled} disabled={!isAdmin} onChange={() => toggle.mutate(rule.id)} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line/70 px-5 py-3 text-xs text-fg-muted">
                <span className="flex items-center gap-3">
                  <span>{rule.runCount}× ausgeführt</span>
                  {rule.lastRunAt && <span>zuletzt {relative(rule.lastRunAt)}</span>}
                  {rule.trigger === 'SCHEDULE' && rule.nextRunAt && rule.enabled && <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{dateTime(rule.nextRunAt)}</span>}
                </span>
                {isAdmin && (
                  <span className="flex gap-1">
                    <Button size="sm" variant="ghost" icon={FlaskConical} loading={test.isPending && test.variables === rule.id} onClick={() => test.mutate(rule.id)}>Testen</Button>
                    <Button size="icon" variant="ghost" icon={Pencil} onClick={() => setEdit(rule)} />
                    <Button size="icon" variant="ghost" icon={Trash2} onClick={async () => (await confirm({ title: `„${rule.name}“ löschen?`, danger: true })) && del.mutate(rule.id)} />
                  </span>
                )}
              </div>
              {rule.lastError && <div className="border-t border-red-500/20 bg-red-500/5 px-5 py-2 text-xs text-red-300">Letzter Fehler: {rule.lastError}</div>}
            </Card>
          ))}
        </div>
      )}
      {edit !== undefined && <RuleEditor rule={edit} onClose={() => setEdit(undefined)} />}
    </>
  );
}

function WelcomeTab() {
  const guildId = useGuildId();
  const toast = useToast();
  const m = useModuleConfig('welcome');
  const test = useMutation({ mutationFn: () => api.post(`/guilds/${guildId}/modules/welcome/test`), onSuccess: () => toast.success('Testnachricht gesendet'), onError: toast.error });
  if (m.isLoading || !m.config) return <LoadingBlock />;
  const c = m.config;
  return (
    <div className="space-y-4">
      <ModuleToggle name="Willkommen" enabled={m.enabled} onChange={m.setEnabled} saving={m.saving} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Begrüßungsnachricht" icon={HandHeart} actions={<Button size="sm" icon={Play} loading={test.isPending} disabled={m.dirty} onClick={() => test.mutate()} title={m.dirty ? 'Zuerst speichern' : 'Sendet die Begrüßung für dich'}>Test</Button>} />
          <div className="space-y-4 p-5">
            <Switch label="Aktiv" checked={c.welcome.enabled} onChange={(v) => m.update((d) => void (d.welcome.enabled = v))} />
            <Field label="Kanal"><ChannelSelect value={c.welcome.channelId} onChange={(v) => m.update((d) => void (d.welcome.channelId = v))} /></Field>
            <Field label="Nachricht" hint="{user} {username} {server} {memberCount}"><Textarea value={c.welcome.message} maxLength={2000} onChange={(e) => m.update((d) => void (d.welcome.message = e.target.value))} /></Field>
            <div className="flex items-center gap-4">
              <Switch label="Als Embed mit Avatar" checked={c.welcome.embed} onChange={(v) => m.update((d) => void (d.welcome.embed = v))} />
              {c.welcome.embed && <input type="color" value={c.welcome.color} onChange={(e) => m.update((d) => void (d.welcome.color = e.target.value))} className="h-9 w-12 rounded-lg border border-line bg-panel-2" />}
            </div>
          </div>
        </Card>
        <Card>
          <CardHeader title="Automatische Rollen" icon={Bell} />
          <div className="space-y-4 p-5">
            <Field label="Rollen für neue Mitglieder"><MultiRoleSelect assignable value={c.autoroles.humans} onChange={(v) => m.update((d) => void (d.autoroles.humans = v))} /></Field>
            <Field label="Rollen für Bots"><MultiRoleSelect assignable value={c.autoroles.bots} onChange={(v) => m.update((d) => void (d.autoroles.bots = v))} /></Field>
            <Field label="Verzögerung" hint="z. B. damit Mitglieder erst die Regeln akzeptieren"><NumberInput value={c.autoroles.delaySeconds} min={0} max={3600} suffix="Sek." onChange={(v) => m.update((d) => void (d.autoroles.delaySeconds = v))} /></Field>
          </div>
        </Card>
        <Card>
          <CardHeader title="Direktnachricht" icon={Bell} />
          <div className="space-y-4 p-5">
            <Switch label="Neuen Mitgliedern eine DM senden" checked={c.dm.enabled} onChange={(v) => m.update((d) => void (d.dm.enabled = v))} />
            <Field label="Nachricht"><Textarea value={c.dm.message} maxLength={2000} onChange={(e) => m.update((d) => void (d.dm.message = e.target.value))} /></Field>
          </div>
        </Card>
        <Card>
          <CardHeader title="Abschiedsnachricht" icon={Bell} />
          <div className="space-y-4 p-5">
            <Switch label="Aktiv" checked={c.leave.enabled} onChange={(v) => m.update((d) => void (d.leave.enabled = v))} />
            <Field label="Kanal"><ChannelSelect value={c.leave.channelId} onChange={(v) => m.update((d) => void (d.leave.channelId = v))} /></Field>
            <Field label="Nachricht" hint="{username} {server} {memberCount}"><Textarea value={c.leave.message} maxLength={2000} onChange={(e) => m.update((d) => void (d.leave.message = e.target.value))} /></Field>
          </div>
        </Card>
      </div>
      <SaveBar dirty={m.dirty} saving={m.saving} onSave={m.save} onReset={m.reset} />
    </div>
  );
}

function RemindersTab() {
  const guildId = useGuildId();
  const { channelName } = useLookup();
  const { data, isLoading } = useQuery({ queryKey: ['automations', 'reminders', guildId], queryFn: () => api.get<{ id: number; userId: string; channelId: string; message: string; remindAt: string }[]>(`/guilds/${guildId}/automations/reminders`) });
  return (
    <Card>
      <CardHeader title="Offene Erinnerungen" description="Mitglieder erstellen Erinnerungen mit /remind" icon={AlarmClock} />
      {isLoading ? <LoadingBlock /> : !data?.length ? <EmptyState icon={AlarmClock} title="Keine offenen Erinnerungen" /> : (
        <div className="divide-y divide-line/60">
          {data.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-5 py-3 text-sm">
              <AlarmClock className="h-4 w-4 text-fg-subtle" />
              <span className="flex-1 truncate">{r.message}</span>
              <span className="text-xs text-fg-muted">{channelName(r.channelId)}</span>
              <span className="text-xs text-fg-subtle">{dateTime(r.remindAt)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function SettingsTab() {
  const m = useModuleConfig('automation');
  if (m.isLoading || !m.config) return <LoadingBlock />;
  return (
    <div className="space-y-4">
      <ModuleToggle name="Automatisierungen" enabled={m.enabled} onChange={m.setEnabled} saving={m.saving} />
      <Card>
        <CardHeader title="Einstellungen" icon={Settings2} />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Zeitzone für Zeitpläne" hint="IANA-Name, z. B. Europe/Berlin"><Input value={m.config.timezone} onChange={(e) => m.update((d) => void (d.timezone = e.target.value))} /></Field>
          <Field label="Max. Ausführungen pro Regel und Minute" hint="Schutz vor Endlosschleifen"><NumberInput value={m.config.maxRunsPerMinute} min={1} max={120} onChange={(v) => m.update((d) => void (d.maxRunsPerMinute = v))} /></Field>
        </div>
      </Card>
      <SaveBar dirty={m.dirty} saving={m.saving} onSave={m.save} onReset={m.reset} />
    </div>
  );
}

export default function AutomationsPage() {
  const [tab, setTab] = useState<'rules' | 'welcome' | 'reminders' | 'settings'>('rules');
  return (
    <>
      <PageHeader title="Automatisierungen" description="Regeln, Begrüßung, Zeitpläne und Erinnerungen" icon={Workflow} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'rules', label: 'Regeln', icon: Workflow }, { id: 'welcome', label: 'Willkommen', icon: HandHeart }, { id: 'reminders', label: 'Erinnerungen', icon: AlarmClock }, { id: 'settings', label: 'Einstellungen', icon: Settings2 }]} />
      {tab === 'rules' && <RulesTab />}
      {tab === 'welcome' && <WelcomeTab />}
      {tab === 'reminders' && <RemindersTab />}
      {tab === 'settings' && <SettingsTab />}
    </>
  );
}
