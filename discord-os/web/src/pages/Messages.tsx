import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, History, ImageIcon, MessageSquarePlus, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { useGuildId, useLookup } from '../hooks/guild';
import { useLiveContext } from '../lib/live';
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, Field, Input, LoadingBlock, PageHeader, Select, Switch, Textarea } from '../components/ui/core';
import { useConfirm, useToast } from '../components/ui/overlay';
import { ChannelSelect } from '../components/ui/pickers';

interface EmbedDraft {
  title: string;
  description: string;
  color: string;
  url: string;
  imageUrl: string;
  thumbnailUrl: string;
  footer: string;
  timestamp: boolean;
  fields: { name: string; value: string; inline: boolean }[];
}

interface Payload {
  content: string;
  embed: EmbedDraft | null;
  mentions: 'none' | 'users' | 'all';
}

interface SentMessage {
  messageId: string;
  channelId: string;
  channelName: string;
  payload: Payload;
  sentBy: string;
  sentAt: string;
  editedAt: string | null;
  url: string;
}

const emptyEmbed = (): EmbedDraft => ({ title: '', description: '', color: '#6366f1', url: '', imageUrl: '', thumbnailUrl: '', footer: '', timestamp: false, fields: [] });
const emptyPayload = (): Payload => ({ content: '', embed: null, mentions: 'users' });

/** Einfache Darstellung von Discord-Markdown für die Vorschau. */
function md(text: string, channelName: (id: string) => string): ReactNode {
  const html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/&lt;#(\d+)&gt;/g, (_, id) => `<span class="rounded bg-[#5865f2]/30 px-1 text-[#c9cdfb]">${channelName(id)}</span>`)
    .replace(/&lt;@&amp;?!?(\d+)&gt;/g, '<span class="rounded bg-[#5865f2]/30 px-1 text-[#c9cdfb]">@erwähnung</span>')
    .replace(/@(everyone|here)/g, '<span class="rounded bg-[#5865f2]/30 px-1 text-[#c9cdfb]">@$1</span>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/`([^`]+)`/g, '<code class="rounded bg-black/30 px-1 text-[0.85em]">$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a class="text-[#00a8fc] hover:underline" href="$2" target="_blank" rel="noreferrer">$1</a>');
  return <span className="whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Preview({ payload }: { payload: Payload }) {
  const { bot } = useLiveContext();
  const { channelName } = useLookup();
  const e = payload.embed;
  const now = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="rounded-xl bg-[#313338] p-4 font-[system-ui] text-[15px] text-[#dbdee1]">
      <div className="flex gap-3">
        <Avatar src={bot?.avatar} name={bot?.tag ?? 'Bot'} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-white">{bot?.tag?.split('#')[0] ?? 'Discord OS'}</span>
            <span className="rounded bg-[#5865f2] px-1 text-[10px] font-semibold text-white">APP</span>
            <span className="text-xs text-[#949ba4]">Heute um {now}</span>
          </div>
          {payload.content && <div className="mt-0.5 leading-snug">{md(payload.content, channelName)}</div>}
          {e && (e.title || e.description || e.imageUrl || e.fields.length > 0) && (
            <div className="mt-1.5 grid max-w-[520px] rounded border-l-4 bg-[#2b2d31] p-3 pr-4" style={{ borderColor: e.color }}>
              <div className="flex gap-3">
                <div className="min-w-0 flex-1">
                  {e.title && <div className={`mb-1 font-semibold ${e.url ? 'text-[#00a8fc]' : 'text-white'}`}>{e.title}</div>}
                  {e.description && <div className="text-sm leading-snug">{md(e.description, channelName)}</div>}
                  {e.fields.length > 0 && (
                    <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-2">
                      {e.fields.map((f, i) => (
                        <div key={i} className={f.inline ? 'col-span-1' : 'col-span-3'}>
                          <div className="text-sm font-semibold text-white">{f.name}</div>
                          <div className="text-sm">{md(f.value, channelName)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {e.thumbnailUrl && <img src={e.thumbnailUrl} alt="" className="h-20 w-20 rounded object-cover" />}
              </div>
              {e.imageUrl && <img src={e.imageUrl} alt="" className="mt-3 max-h-72 rounded object-contain" />}
              {(e.footer || e.timestamp) && (
                <div className="mt-2 text-xs text-[#949ba4]">
                  {e.footer}
                  {e.footer && e.timestamp && ' • '}
                  {e.timestamp && `Heute um ${now}`}
                </div>
              )}
            </div>
          )}
          {!payload.content && !e && <div className="text-sm text-[#949ba4] italic">Die Vorschau erscheint, sobald du etwas schreibst.</div>}
        </div>
      </div>
    </div>
  );
}

function Composer({ editing, onDone }: { editing: SentMessage | null; onDone: () => void }) {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const [channelId, setChannelId] = useState<string | null>(editing?.channelId ?? null);
  const [p, setP] = useState<Payload>(() => (editing ? structuredClone(editing.payload) : emptyPayload()));
  const setEmbed = (patch: Partial<EmbedDraft>) => setP((x) => ({ ...x, embed: { ...(x.embed ?? emptyEmbed()), ...patch } }));

  const send = useMutation({
    mutationFn: () =>
      editing
        ? api.put<{ url: string }>(`/guilds/${guildId}/messages/${editing.messageId}`, { payload: p })
        : api.post<{ url: string }>(`/guilds/${guildId}/messages`, { channelId, payload: p }),
    onSuccess: () => {
      toast.success(editing ? 'Nachricht aktualisiert' : 'Nachricht gesendet');
      void qc.invalidateQueries({ queryKey: ['bot-messages', guildId] });
      setP(emptyPayload());
      onDone();
    },
    onError: toast.error,
  });

  const e = p.embed;
  const empty = !p.content.trim() && !(e && (e.title || e.description || e.imageUrl || e.fields.length));

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader
          title={editing ? 'Nachricht bearbeiten' : 'Neue Nachricht'}
          description={editing ? `In #${editing.channelName}` : 'Der Bot sendet die Nachricht in den gewählten Kanal.'}
          icon={MessageSquarePlus}
          actions={editing && <Button size="sm" variant="ghost" icon={X} onClick={() => (setP(emptyPayload()), onDone())}>Abbrechen</Button>}
        />
        <div className="space-y-4 p-5">
          {!editing && (
            <Field label="Kanal">
              <ChannelSelect value={channelId} onChange={setChannelId} />
            </Field>
          )}
          <Field label="Text" hint="Markdown: **fett**, *kursiv*, __unterstrichen__, ~~durchgestrichen~~, `code`, [Link](https://…) · Kanal: <#ID> · Rolle: <@&ID>">
            <Textarea value={p.content} maxLength={2000} className="min-h-[120px]" onChange={(ev) => setP({ ...p, content: ev.target.value })} placeholder="Deine Nachricht …" />
          </Field>
          <Field label="Erwähnungen">
            <Select value={p.mentions} onChange={(ev) => setP({ ...p, mentions: ev.target.value as Payload['mentions'] })}>
              <option value="users">Nur Nutzer anpingen</option>
              <option value="all">Nutzer, Rollen und @everyone anpingen</option>
              <option value="none">Niemanden anpingen</option>
            </Select>
          </Field>
          <Switch label="Embed hinzufügen" description="Formatierte Box mit Titel, Farbe, Bild und Feldern" checked={!!e} onChange={(v) => setP({ ...p, embed: v ? emptyEmbed() : null })} />

          {e && (
            <div className="space-y-4 rounded-xl border border-line bg-panel-2/40 p-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <Field label="Titel"><Input value={e.title} maxLength={256} onChange={(ev) => setEmbed({ title: ev.target.value })} /></Field>
                <Field label="Farbe">
                  <div className="flex items-center gap-2">
                    <input type="color" value={e.color} onChange={(ev) => setEmbed({ color: ev.target.value })} className="h-10 w-12 cursor-pointer rounded-lg border border-line bg-panel-2" />
                    <Input value={e.color} onChange={(ev) => setEmbed({ color: ev.target.value })} className="w-28" />
                  </div>
                </Field>
              </div>
              <Field label="Titel-Link (optional)"><Input value={e.url} placeholder="https://…" onChange={(ev) => setEmbed({ url: ev.target.value })} /></Field>
              <Field label="Beschreibung"><Textarea value={e.description} maxLength={4000} onChange={(ev) => setEmbed({ description: ev.target.value })} /></Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Bild-URL (groß)" hint="Direktlink auf .png/.jpg/.gif"><Input value={e.imageUrl} placeholder="https://…" onChange={(ev) => setEmbed({ imageUrl: ev.target.value })} /></Field>
                <Field label="Vorschaubild-URL (klein)"><Input value={e.thumbnailUrl} placeholder="https://…" onChange={(ev) => setEmbed({ thumbnailUrl: ev.target.value })} /></Field>
              </div>
              <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto]">
                <Field label="Fußzeile"><Input value={e.footer} maxLength={2048} onChange={(ev) => setEmbed({ footer: ev.target.value })} /></Field>
                <div className="pb-2"><Switch label="Zeitstempel" checked={e.timestamp} onChange={(v) => setEmbed({ timestamp: v })} /></div>
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="label mb-0">Felder</span>
                  <Button size="sm" icon={Plus} disabled={e.fields.length >= 25} onClick={() => setEmbed({ fields: [...e.fields, { name: 'Titel', value: 'Inhalt', inline: true }] })}>Feld</Button>
                </div>
                <div className="space-y-2">
                  {e.fields.map((f, i) => (
                    <div key={i} className="grid items-center gap-2 rounded-lg border border-line p-2 sm:grid-cols-[1fr_1.5fr_auto_auto]">
                      <Input value={f.name} maxLength={256} placeholder="Name" onChange={(ev) => setEmbed({ fields: e.fields.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)) })} />
                      <Input value={f.value} maxLength={1024} placeholder="Wert" onChange={(ev) => setEmbed({ fields: e.fields.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)) })} />
                      <Switch label={<span className="text-xs">Nebeneinander</span>} checked={f.inline} onChange={(v) => setEmbed({ fields: e.fields.map((x, j) => (j === i ? { ...x, inline: v } : x)) })} />
                      <Button size="icon" variant="ghost" icon={Trash2} onClick={() => setEmbed({ fields: e.fields.filter((_, j) => j !== i) })} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="primary" icon={Send} disabled={empty || (!editing && !channelId)} loading={send.isPending} onClick={() => send.mutate()}>
              {editing ? 'Änderungen speichern' : 'Senden'}
            </Button>
          </div>
        </div>
      </Card>
      <div className="space-y-4 xl:sticky xl:top-24 xl:self-start">
        <Card>
          <CardHeader title="Vorschau" description="So ungefähr sieht die Nachricht in Discord aus" icon={ImageIcon} />
          <div className="p-5">
            <Preview payload={p} />
          </div>
        </Card>
      </div>
    </div>
  );
}

function SentList({ onEdit }: { onEdit: (m: SentMessage) => void }) {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery({ queryKey: ['bot-messages', guildId], queryFn: () => api.get<SentMessage[]>(`/guilds/${guildId}/messages`) });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/guilds/${guildId}/messages/${id}`),
    onSuccess: () => (toast.success('Nachricht gelöscht'), void qc.invalidateQueries({ queryKey: ['bot-messages', guildId] })),
    onError: toast.error,
  });
  return (
    <Card className="mt-4">
      <CardHeader title="Gesendete Nachrichten" description="Über das Dashboard oder /say gesendet – bearbeiten oder löschen" icon={History} />
      {isLoading ? (
        <LoadingBlock />
      ) : !data?.length ? (
        <EmptyState icon={Send} title="Noch keine Nachrichten gesendet" />
      ) : (
        <div className="divide-y divide-line/60">
          {data.map((m) => (
            <div key={m.messageId} className="flex items-center gap-3 px-5 py-3">
              <Badge color="brand">#{m.channelName}</Badge>
              <span className="flex-1 truncate text-sm">{m.payload.content || m.payload.embed?.title || m.payload.embed?.description || 'Embed'}</span>
              {m.editedAt && <Badge>bearbeitet</Badge>}
              <span className="text-xs text-fg-subtle">{relative(m.sentAt)}</span>
              <a href={m.url} target="_blank" rel="noreferrer" title="In Discord öffnen"><Button size="icon" variant="ghost" icon={ExternalLink} /></a>
              <Button size="icon" variant="ghost" icon={Pencil} onClick={() => onEdit(m)} />
              <Button size="icon" variant="ghost" icon={Trash2} onClick={async () => (await confirm({ title: 'Nachricht löschen?', message: 'Sie wird auch in Discord gelöscht.', danger: true, confirmLabel: 'Löschen' })) && del.mutate(m.messageId)} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function MessagesPage() {
  const [editing, setEditing] = useState<SentMessage | null>(null);
  return (
    <>
      <PageHeader title="Nachrichten" description="Nachrichten und Embeds im Namen des Bots senden" icon={Send} />
      <Composer key={editing?.messageId ?? 'new'} editing={editing} onDone={() => setEditing(null)} />
      <SentList onEdit={(m) => (setEditing(m), window.scrollTo({ top: 0, behavior: 'smooth' }))} />
    </>
  );
}
