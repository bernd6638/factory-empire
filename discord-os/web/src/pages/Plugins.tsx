import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AudioLines, AlertTriangle, ArrowRight, Coins, Database, Gavel, Gift, HandHeart, Mic, Puzzle, RotateCcw, ScrollText, ShieldAlert, Terminal, Ticket, TrendingUp, Workflow, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import type { ModuleKey } from '../lib/types';
import { useCan, useGuildId } from '../hooks/guild';
import { Badge, Button, Card, CardHeader, LoadingBlock, PageHeader, Switch } from '../components/ui/core';
import { useConfirm, useToast } from '../components/ui/overlay';

interface ModuleInfo {
  key: ModuleKey;
  name: string;
  description: string;
  icon: string;
  category: string;
  enabled: boolean;
  updatedAt: string | null;
  errors: number;
  lastError: { message: string; label: string; at: number } | null;
  data: Record<string, number>;
}

const ICONS: Record<string, LucideIcon> = { AudioLines, Gift, Gavel, ShieldAlert, ScrollText, TrendingUp, HandHeart, Ticket, Coins, Workflow, Mic };
const ROUTES: Record<ModuleKey, string> = { moderation: 'moderation', automod: 'moderation', logging: 'logs', leveling: 'leveling', welcome: 'automations', tickets: 'tickets', economy: 'economy', automation: 'automations', voice: 'voice', giveaways: 'giveaways', voiceai: 'voiceai' };

export default function PluginsPage() {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const isAdmin = useCan('ADMIN');
  const isOwner = useCan('OWNER');
  const { data, isLoading } = useQuery({ queryKey: ['modules', guildId], queryFn: () => api.get<ModuleInfo[]>(`/guilds/${guildId}/modules`) });
  const { data: commands } = useQuery({ queryKey: ['commands', guildId], queryFn: () => api.get<{ name: string; description: string; module: string }[]>(`/guilds/${guildId}/server/commands`), retry: false });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['modules', guildId] });
    void qc.invalidateQueries({ queryKey: ['guild', guildId] });
    void qc.invalidateQueries({ queryKey: ['module', guildId] });
  };
  const toggle = useMutation({ mutationFn: (p: { key: string; enabled: boolean }) => api.put(`/guilds/${guildId}/modules/${p.key}`, { enabled: p.enabled }), onSuccess: (_, p) => (toast.success(p.enabled ? 'Modul aktiviert' : 'Modul deaktiviert'), invalidate()), onError: toast.error });
  const resetCfg = useMutation({ mutationFn: (key: string) => api.post(`/guilds/${guildId}/modules/${key}/reset`), onSuccess: () => (toast.success('Einstellungen auf Standard zurückgesetzt'), invalidate()), onError: toast.error });
  const resetData = useMutation({ mutationFn: (key: string) => api.post(`/guilds/${guildId}/modules/${key}/data/reset`, { confirm: key }), onSuccess: () => (toast.success('Moduldaten gelöscht'), invalidate()), onError: toast.error });

  if (isLoading || !data) return <LoadingBlock />;
  const categories = [...new Set(data.map((m) => m.category))];
  return (
    <>
      <PageHeader title="Plugins" description="Module aktivieren, konfigurieren und ihre Daten verwalten. Jedes Modul läuft isoliert." icon={Puzzle} />
      {categories.map((cat) => (
        <div key={cat} className="mb-8">
          <h2 className="mb-3 text-sm font-semibold tracking-wider text-fg-subtle uppercase">{cat}</h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.filter((m) => m.category === cat).map((m, i) => {
              const Icon = ICONS[m.icon] ?? Puzzle;
              const hasData = Object.keys(m.data).length > 0;
              return (
                <Card key={m.key} delay={i * 0.04} hover className="flex flex-col">
                  <div className="flex items-start justify-between gap-3 p-5">
                    <div className={`rounded-xl p-3 ring-1 transition ${m.enabled ? 'bg-gradient-to-br from-brand-500/20 to-accent-500/10 text-brand-300 ring-brand-500/30' : 'bg-panel-3 text-fg-subtle ring-line'}`}><Icon className="h-6 w-6" /></div>
                    <Switch checked={m.enabled} disabled={!isAdmin || toggle.isPending} onChange={(v) => toggle.mutate({ key: m.key, enabled: v })} />
                  </div>
                  <div className="flex-1 px-5">
                    <div className="flex items-center gap-2"><h3 className="font-semibold">{m.name}</h3>{m.enabled ? <Badge color="green" dot>Aktiv</Badge> : <Badge>Aus</Badge>}</div>
                    <p className="mt-1 text-sm text-fg-muted">{m.description}</p>
                    {hasData && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {Object.entries(m.data).map(([k, v]) => <Badge key={k} color="blue"><Database className="h-3 w-3" />{v.toLocaleString('de-DE')} {k}</Badge>)}
                      </div>
                    )}
                    {m.errors > 0 && (
                      <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5 text-xs text-amber-200">
                        <div className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-3.5 w-3.5" />{m.errors} Fehler seit Start (alle Server)</div>
                        {m.lastError && <div className="mt-1 text-amber-200/80">{m.lastError.label}: {m.lastError.message} · {relative(new Date(m.lastError.at))}</div>}
                      </div>
                    )}
                  </div>
                  <div className="mt-4 flex items-center justify-between gap-2 border-t border-line/70 px-5 py-3">
                    <div className="flex gap-1">
                      {isAdmin && <Button size="sm" variant="ghost" icon={RotateCcw} onClick={async () => (await confirm({ title: `Einstellungen von „${m.name}“ zurücksetzen?`, message: 'Alle Einstellungen dieses Moduls werden auf die Standardwerte gesetzt.' })) && resetCfg.mutate(m.key)}>Standard</Button>}
                      {isOwner && hasData && !['voice'].includes(m.key) && (
                        <Button size="sm" variant="ghost" icon={Database} onClick={async () => (await confirm({ title: `Daten von „${m.name}“ löschen?`, message: `Gelöscht wird: ${Object.keys(m.data).join(', ')}. Dies kann nicht rückgängig gemacht werden.`, danger: true, typeToConfirm: m.key, confirmLabel: 'Endgültig löschen' })) && resetData.mutate(m.key)}>Daten</Button>
                      )}
                    </div>
                    <Link to={`/guild/${guildId}/${ROUTES[m.key]}`} className="flex items-center gap-1 text-sm text-brand-300 hover:text-brand-400">Konfigurieren <ArrowRight className="h-4 w-4" /></Link>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      ))}
      <Card>
        <CardHeader title="Slash-Commands" description="Alle registrierten Befehle des Bots (deaktivierte Module antworten mit einem Hinweis)" icon={Terminal} />
        <div className="grid gap-x-6 gap-y-1 p-5 sm:grid-cols-2 xl:grid-cols-3">
          {(commands ?? []).map((c) => (
            <div key={c.name} className="flex items-baseline gap-2 py-1 text-sm">
              <code className="rounded bg-panel-3 px-1.5 py-0.5 text-brand-300">/{c.name}</code>
              <span className="truncate text-fg-muted">{c.description}</span>
            </div>
          ))}
          {!commands && <p className="text-sm text-fg-subtle">Bot nicht erreichbar.</p>}
        </div>
      </Card>
    </>
  );
}
