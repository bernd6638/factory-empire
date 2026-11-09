import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { AudioLines, Bot, BrainCircuit, CheckCircle2, CircleDashed, Download, Ear, LogOut, MessageCircle, Mic, RotateCcw, Send, Settings2, Shield, Sparkles, Volume2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { useLive } from '../lib/live';
import { cn, relative } from '../lib/format';
import { useCan, useGuildId, useModuleConfig } from '../hooks/guild';
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, Field, Input, LoadingBlock, NumberInput, PageHeader, Select, Switch, Tabs, Textarea } from '../components/ui/core';
import { useToast } from '../components/ui/overlay';
import { ChannelSelect, MultiRoleSelect, TagInput } from '../components/ui/pickers';
import { ModuleToggle, SaveBar } from '../components/ui/module';

interface Status {
  session: { connected: boolean; channelId?: string; channelName?: string; listeners?: { id: string; name: string; avatar: string }[]; turns?: number; startedAt?: number; busy?: boolean };
  health: {
    speech: { ok: boolean; error?: string; whisperModel?: string; whisperLoaded?: boolean; device?: string; voices?: string[] };
    ollama: { ok: boolean; error?: string; models?: { name: string; sizeGb: number }[] };
    modelReady: boolean;
    model: string;
    pull: { model: string; status: 'running' | 'done' | 'error'; percent?: number; error?: string; step?: string } | null;
  };
}

interface Line {
  id: string;
  kind: 'heard' | 'turn';
  name: string;
  text: string;
  answer?: string;
  triggered?: boolean;
  ms?: number;
  at: number;
}

const MODELS = [
  { id: 'qwen2.5:7b', label: 'Qwen 2.5 · 7B', hint: 'Empfohlen für 8 GB Grafikspeicher – gutes Deutsch (~4,7 GB)' },
  { id: 'llama3.1:8b', label: 'Llama 3.1 · 8B', hint: 'Sehr natürliche Gespräche (~4,9 GB)' },
  { id: 'qwen2.5:3b', label: 'Qwen 2.5 · 3B', hint: 'Schneller, für 4–6 GB Grafikspeicher (~1,9 GB)' },
  { id: 'llama3.2:3b', label: 'Llama 3.2 · 3B', hint: 'Schnell und klein (~2 GB)' },
];

const VOICES = [
  { id: 'de_DE-thorsten-medium', label: 'Thorsten (männlich, natürlich)' },
  { id: 'de_DE-thorsten-high', label: 'Thorsten HQ (männlich, beste Qualität, langsamer)' },
  { id: 'de_DE-thorsten_emotional-medium', label: 'Thorsten emotional (männlich)' },
  { id: 'de_DE-kerstin-low', label: 'Kerstin (weiblich)' },
  { id: 'de_DE-ramona-low', label: 'Ramona (weiblich)' },
  { id: 'de_DE-eva_k-x_low', label: 'Eva (weiblich, sehr schnell)' },
  { id: 'de_DE-karlsson-low', label: 'Karlsson (männlich)' },
  { id: 'de_DE-pavoque-low', label: 'Pavoque (männlich)' },
];

function Check({ ok, pending, label, detail }: { ok: boolean; pending?: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-line/70 bg-white/[0.015] px-4 py-3">
      {ok ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-400" /> : pending ? <CircleDashed className="mt-0.5 h-5 w-5 animate-spin text-brand-300" /> : <XCircle className="mt-0.5 h-5 w-5 text-red-400" />}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="truncate text-xs text-fg-subtle">{detail}</div>
      </div>
    </div>
  );
}

function LiveTab() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const canMod = useCan('MODERATOR');
  const isAdmin = useCan('ADMIN');
  const [channelId, setChannelId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [ask, setAsk] = useState('');
  const [answer, setAnswer] = useState<{ answer: string; ms: number } | null>(null);
  const m = useModuleConfig('voiceai');
  const { data, isLoading, refetch } = useQuery({ queryKey: ['voiceai', guildId], queryFn: () => api.get<Status>(`/guilds/${guildId}/voiceai`), refetchInterval: (q) => (q.state.data?.health.pull?.status === 'running' ? 2000 : 15_000) });

  useLive(['voiceai.session', 'voiceai.pull'], () => void refetch());
  useLive('voiceai.heard', (ev) => setLines((l) => [{ id: `h${ev.ts}`, kind: 'heard' as const, name: ev.data.name, text: ev.data.text, triggered: ev.data.triggered, at: ev.data.at }, ...l].slice(0, 60)));
  useLive('voiceai.turn', (ev) => {
    setLines((l) => [{ id: `t${ev.ts}`, kind: 'turn' as const, name: ev.data.name, text: ev.data.text, answer: ev.data.answer, ms: ev.data.llmMs, at: ev.data.at }, ...l].slice(0, 60));
    void qc.invalidateQueries({ queryKey: ['voiceai', guildId] });
  });

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api.post(`/guilds/${guildId}/voiceai/${path}`, body),
    onSuccess: (_, v) => {
      if (v.path === 'join') toast.success('Der Bot ist dem Sprachkanal beigetreten');
      if (v.path === 'leave') toast.success('Sprachkanal verlassen');
      if (v.path === 'reset') toast.success('Gesprächsverlauf gelöscht');
      if (v.path === 'pull') toast.info('Download gestartet – das kann einige Minuten dauern');
      if (v.path === 'say') toast.success('Wird vorgelesen');
      void refetch();
    },
    onError: toast.error,
  });
  const askMut = useMutation({ mutationFn: () => api.post<{ answer: string; ms: number }>(`/guilds/${guildId}/voiceai/ask`, { text: ask }), onSuccess: setAnswer, onError: toast.error });

  if (isLoading || !data) return <LoadingBlock />;
  const h = data.health;
  const s = data.session;
  const pull = h.pull;
  const ready = h.speech.ok && h.ollama.ok && h.modelReady;

  return (
    <div className="space-y-4">
      {!m.enabled && m.config && <ModuleToggle name="KI-Sprach-Bot" enabled={m.enabled} onChange={m.setEnabled} saving={m.saving} />}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Einrichtung" description="Alles läuft lokal auf deinem PC – keine Kosten, keine Daten an fremde Dienste" icon={Sparkles} actions={ready ? <Badge color="green" dot>Bereit</Badge> : <Badge color="yellow">Unvollständig</Badge>} />
          <div className="grid gap-3 p-5 md:grid-cols-3">
            <Check ok={h.speech.ok} label="Sprachdienst" detail={h.speech.ok ? `Whisper ${h.speech.whisperModel} ${h.speech.whisperLoaded ? 'geladen' : 'lädt …'} · Piper` : (h.speech.error ?? 'nicht erreichbar')} />
            <Check ok={h.ollama.ok} label="Ollama" detail={h.ollama.ok ? `${h.ollama.models?.length ?? 0} Modell(e) installiert` : (h.ollama.error ?? 'nicht erreichbar')} />
            <Check ok={h.modelReady} pending={pull?.status === 'running'} label={`Modell ${h.model}`} detail={h.modelReady ? 'installiert' : pull?.status === 'running' ? `wird geladen … ${pull.percent ?? 0} %` : 'noch nicht heruntergeladen'} />
          </div>
          {(!h.speech.ok || !h.ollama.ok) && (
            <div className="mx-5 mb-5 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-200">
              Die KI-Dienste laufen noch nicht. Starte Discord OS mit dem Sprach-Profil:
              <code className="mt-2 block rounded-lg bg-black/40 px-3 py-2 text-xs text-fg">docker compose --profile app --profile voice up -d --build</code>
              Anleitung: <code>docs/SPRACH-BOT.md</code>
            </div>
          )}
          {h.ollama.ok && !h.modelReady && (
            <div className="mx-5 mb-5 space-y-3 rounded-xl border border-brand-500/25 bg-brand-500/5 p-4">
              <div className="text-sm">Das Sprachmodell <b>{h.model}</b> muss einmalig heruntergeladen werden (mehrere GB).</div>
              {pull?.status === 'running' && pull.model === h.model ? (
                <div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/5"><div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500 transition-all" style={{ width: `${pull.percent ?? 0}%` }} /></div>
                  <div className="mt-1 text-xs text-fg-subtle">{pull.percent ?? 0} % · {pull.step}</div>
                </div>
              ) : (
                <Button variant="primary" icon={Download} disabled={!isAdmin} loading={act.isPending && act.variables?.path === 'pull'} onClick={() => act.mutate({ path: 'pull', body: { model: h.model } })}>Modell herunterladen</Button>
              )}
              {pull?.status === 'error' && <div className="text-xs text-red-300">Fehler: {pull.error}</div>}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Sprachkanal" icon={Mic} actions={s.connected ? <Badge color="green" dot>Verbunden</Badge> : <Badge>Getrennt</Badge>} />
          <div className="space-y-4 p-5">
            {s.connected ? (
              <>
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <div className="absolute inset-0 animate-ping rounded-full bg-emerald-400/20" />
                    <div className="relative rounded-full bg-emerald-500/15 p-3 text-emerald-300 ring-1 ring-emerald-500/30"><AudioLines className="h-5 w-5" /></div>
                  </div>
                  <div>
                    <div className="font-medium">{s.channelName}</div>
                    <div className="text-xs text-fg-subtle">{s.turns} Antworten · seit {relative(s.startedAt ? new Date(s.startedAt) : null)}</div>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {s.listeners?.map((l) => <span key={l.id} className="flex items-center gap-1.5 rounded-full bg-panel-3 py-0.5 pr-2.5 pl-0.5 text-xs"><Avatar src={l.avatar} name={l.name} size={20} />{l.name}</span>)}
                </div>
                {canMod && (
                  <div className="flex gap-2">
                    <Button size="sm" icon={RotateCcw} onClick={() => act.mutate({ path: 'reset' })}>Verlauf vergessen</Button>
                    <Button size="sm" variant="danger" icon={LogOut} onClick={() => act.mutate({ path: 'leave' })}>Verlassen</Button>
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="text-sm text-fg-muted">Lass den Bot einem Sprachkanal beitreten – oder nutze <code className="text-brand-300">/talk join</code> in Discord.</p>
                <ChannelSelect kinds={['voice']} value={channelId} onChange={setChannelId} placeholder="Sprachkanal wählen …" />
                <Button variant="primary" icon={Mic} className="w-full" disabled={!channelId || !canMod || !m.enabled} loading={act.isPending && act.variables?.path === 'join'} onClick={() => act.mutate({ path: 'join', body: { channelId } })}>Beitreten</Button>
                {!m.enabled && <p className="text-xs text-amber-300">Modul zuerst unter „Einstellungen“ aktivieren.</p>}
              </>
            )}
          </div>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Live-Mitschrift" description="Was der Bot versteht und antwortet (nur in dieser Ansicht, nicht gespeichert)" icon={Ear} />
          {lines.length === 0 ? (
            <EmptyState icon={AudioLines} title="Noch nichts gehört" description={`Sprich im Sprachkanal: „${m.config?.botName ?? 'Rad'}, erzähl mir einen Witz.“`} />
          ) : (
            <div className="max-h-[480px] space-y-3 overflow-y-auto p-5">
              <AnimatePresence initial={false}>
                {lines.map((l) => (
                  <motion.div key={l.id} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className={cn('rounded-xl border p-3', l.kind === 'turn' ? 'border-brand-500/25 bg-brand-500/[0.05]' : 'border-line/60 bg-white/[0.01]')}>
                    <div className="flex items-center gap-2 text-xs text-fg-subtle">
                      <MessageCircle className="h-3.5 w-3.5" /> <span className="font-medium text-fg-muted">{l.name}</span> · {relative(new Date(l.at))}
                      {l.kind === 'heard' && !l.triggered && <Badge>ignoriert</Badge>}
                      {l.ms !== undefined && <span className="ml-auto">{(l.ms / 1000).toFixed(1)} s Denkzeit</span>}
                    </div>
                    <div className="mt-1 text-sm">{l.text}</div>
                    {l.answer && <div className="mt-2 flex gap-2 text-sm text-brand-300"><Bot className="mt-0.5 h-4 w-4 shrink-0" />{l.answer}</div>}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title="Testen" description="Ohne Sprachkanal prüfen, ob das Sprachmodell antwortet" icon={BrainCircuit} />
          <div className="space-y-3 p-5">
            <Textarea value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Schreib etwas, z. B. „Erzähl mir einen Witz“" className="min-h-[70px]" maxLength={500} />
            <div className="flex gap-2">
              <Button variant="primary" icon={Send} disabled={!ask.trim() || !h.modelReady} loading={askMut.isPending} onClick={() => askMut.mutate()}>Fragen</Button>
              <Button icon={Volume2} disabled={!s.connected || !(answer?.answer || ask.trim())} loading={act.isPending && act.variables?.path === 'say'} onClick={() => act.mutate({ path: 'say', body: { text: answer?.answer || ask } })}>Vorlesen</Button>
            </div>
            {answer && (
              <div className="rounded-xl border border-brand-500/25 bg-brand-500/[0.05] p-3 text-sm">
                <div className="mb-1 text-xs text-fg-subtle">Antwort in {(answer.ms / 1000).toFixed(1)} s</div>
                {answer.answer}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function SettingsTab() {
  const m = useModuleConfig('voiceai');
  if (m.isLoading || !m.config) return <LoadingBlock compact />;
  const c = m.config;
  const custom = !MODELS.some((x) => x.id === c.model);
  return (
    <div className="space-y-4">
      <ModuleToggle name="KI-Sprach-Bot" enabled={m.enabled} onChange={m.setEnabled} saving={m.saving} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Persönlichkeit" icon={Sparkles} />
          <div className="space-y-4 p-5">
            <Field label="Name des Bots" hint="Mit diesem Namen sprichst du ihn an: „Rad, …“ oder „Hey Rad, …“"><Input value={c.botName} maxLength={32} onChange={(e) => m.update((d) => void (d.botName = e.target.value))} /></Field>
            <Field label="Weitere Aktivierungswörter"><TagInput value={c.wakeWords} onChange={(v) => m.update((d) => void (d.wakeWords = v))} placeholder="z. B. Computer" /></Field>
            <Switch label="Nur auf Ansprache reagieren" description="Aus: Der Bot antwortet auf alles, was gesagt wird" checked={c.requireWakeWord} onChange={(v) => m.update((d) => void (d.requireWakeWord = v))} />
            <Field label="Weiterreden ohne Ansprache" hint="Nach einer Antwort kann man so lange direkt weitersprechen"><NumberInput value={c.followUpSeconds} min={0} max={120} suffix="Sek." onChange={(v) => m.update((d) => void (d.followUpSeconds = v))} /></Field>
            <Field label="Charakter (Systemanweisung)" hint="{name} und {server} werden ersetzt"><Textarea value={c.persona} maxLength={2000} className="min-h-[130px]" onChange={(e) => m.update((d) => void (d.persona = e.target.value))} /></Field>
          </div>
        </Card>
        <Card>
          <CardHeader title="KI & Stimme" icon={BrainCircuit} />
          <div className="space-y-4 p-5">
            <Field label="Sprachmodell (Ollama)">
              <Select value={custom ? '__custom' : c.model} onChange={(e) => m.update((d) => void (d.model = e.target.value === '__custom' ? '' : e.target.value))}>
                {MODELS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                <option value="__custom">Anderes Modell …</option>
              </Select>
            </Field>
            {custom ? <Field label="Modellname" hint="Name aus ollama.com/library, z. B. mistral:7b"><Input value={c.model} onChange={(e) => m.update((d) => void (d.model = e.target.value.trim()))} /></Field> : <p className="-mt-2 text-xs text-fg-subtle">{MODELS.find((x) => x.id === c.model)?.hint}</p>}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Kreativität"><NumberInput value={c.temperature} min={0} max={1.5} step={0.1} onChange={(v) => m.update((d) => void (d.temperature = v))} /></Field>
              <Field label="Max. Antwortlänge"><NumberInput value={c.maxTokens} min={20} max={600} suffix="Tok." onChange={(v) => m.update((d) => void (d.maxTokens = v))} /></Field>
              <Field label="Gedächtnis"><NumberInput value={c.historyTurns} min={0} max={30} suffix="Runden" onChange={(v) => m.update((d) => void (d.historyTurns = v))} /></Field>
            </div>
            <Field label="Stimme"><Select value={c.voice} onChange={(e) => m.update((d) => void (d.voice = e.target.value))}>{VOICES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</Select></Field>
            <Field label="Sprechtempo"><NumberInput value={c.speechRate} min={0.5} max={2} step={0.1} suffix="×" onChange={(v) => m.update((d) => void (d.speechRate = v))} /></Field>
          </div>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader title="Zugriff & Datenschutz" icon={Shield} />
          <div className="grid gap-4 p-5 md:grid-cols-2">
            <Field label="Nur diese Rollen dürfen mit dem Bot reden" hint="Leer = alle im Sprachkanal"><MultiRoleSelect value={c.allowedRoleIds} onChange={(v) => m.update((d) => void (d.allowedRoleIds = v))} /></Field>
            <Field label="Mitschrift in Textkanal (optional)" hint="Leer = keine Mitschrift in Discord"><ChannelSelect value={c.transcriptChannelId} onChange={(v) => m.update((d) => void (d.transcriptChannelId = v))} placeholder="Keine Mitschrift" /></Field>
            <Field label="Automatisch gehen nach" hint="Wenn niemand mehr im Kanal ist"><NumberInput value={c.autoLeaveMinutes} min={1} max={120} suffix="Min." onChange={(v) => m.update((d) => void (d.autoLeaveMinutes = v))} /></Field>
            <div className="flex items-end pb-2"><Switch label="Beim Beitreten Hinweis senden" description="Informiert alle, dass der Bot zuhört" checked={c.announceJoin} onChange={(v) => m.update((d) => void (d.announceJoin = v))} /></div>
          </div>
        </Card>
      </div>
      <SaveBar dirty={m.dirty} saving={m.saving} onSave={m.save} onReset={m.reset} />
    </div>
  );
}

export default function VoiceAIPage() {
  const [tab, setTab] = useState<'live' | 'settings'>('live');
  return (
    <>
      <PageHeader title="KI-Sprach-Bot" description="Der Bot unterhält sich mit euch im Sprachkanal – lokal mit Whisper, Ollama und Piper" icon={AudioLines} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'live', label: 'Live', icon: AudioLines }, { id: 'settings', label: 'Einstellungen', icon: Settings2 }]} />
      {tab === 'live' ? <LiveTab /> : <SettingsTab />}
    </>
  );
}
