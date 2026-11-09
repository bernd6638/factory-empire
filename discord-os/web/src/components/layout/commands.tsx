import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, BarChart3, CornerDownLeft, Gavel, Gift, Search, Send, User, Vote, Workflow, Zap, type LucideIcon } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, qs } from '../../lib/api';
import { cn } from '../../lib/format';
import { ACCESS_RANK, type AccessName } from '../../lib/types';
import { useGuild, useGuildId } from '../../hooks/guild';
import { Avatar, Button, Field, Input, NumberInput, Switch } from '../ui/core';
import { Modal, useToast } from '../ui/overlay';
import { ChannelSelect } from '../ui/pickers';
import { ModActionModal } from '../shared/ModActionModal';
import { ALL_NAV_ITEMS } from './nav';

export interface QuickAction {
  id: 'giveaway' | 'poll' | 'message' | 'automation' | 'modaction' | 'analytics';
  label: string;
  description: string;
  icon: LucideIcon;
  min: AccessName;
}

export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'giveaway', label: 'Gewinnspiel erstellen', description: 'Neues Giveaway mit Editor', icon: Gift, min: 'MODERATOR' },
  { id: 'poll', label: 'Umfrage starten', description: 'Discord-Umfrage sofort senden', icon: Vote, min: 'MODERATOR' },
  { id: 'message', label: 'Nachricht senden', description: 'Text oder Embed als Bot', icon: Send, min: 'MODERATOR' },
  { id: 'modaction', label: 'Moderationsaktion', description: 'Warn, Timeout, Kick, Bann', icon: Gavel, min: 'MODERATOR' },
  { id: 'automation', label: 'Automatisierung erstellen', description: 'Neue Regel im Builder', icon: Workflow, min: 'ADMIN' },
  { id: 'analytics', label: 'Serverstatistiken öffnen', description: 'Live Analytics', icon: BarChart3, min: 'VIEWER' },
];

interface Ctx {
  run: (id: QuickAction['id']) => void;
  openPalette: () => void;
  actions: QuickAction[];
}
const QuickCtx = createContext<Ctx>({ run: () => undefined, openPalette: () => undefined, actions: [] });
export const useQuickActions = () => useContext(QuickCtx);

function QuickPollModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const guildId = useGuildId();
  const toast = useToast();
  const [channelId, setChannelId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState(['', '']);
  const [hours, setHours] = useState(24);
  const [multi, setMulti] = useState(false);
  const send = useMutation({
    mutationFn: () => api.post(`/guilds/${guildId}/messages/poll`, { channelId, question, answers: answers.map((a) => a.trim()).filter(Boolean), durationHours: hours, allowMultiselect: multi }),
    onSuccess: () => {
      toast.success('Umfrage gestartet');
      setQuestion('');
      setAnswers(['', '']);
      onClose();
    },
    onError: toast.error,
  });
  const valid = !!channelId && question.trim() && answers.filter((a) => a.trim()).length >= 2;
  return (
    <Modal open={open} onClose={onClose} title="Umfrage starten" description="Wird als native Discord-Umfrage gesendet – Ergebnisse zeigt Discord live an." footer={<Button variant="primary" icon={Vote} disabled={!valid} loading={send.isPending} onClick={() => send.mutate()}>Umfrage senden</Button>}>
      <div className="space-y-4">
        <Field label="Kanal"><ChannelSelect value={channelId} onChange={setChannelId} /></Field>
        <Field label="Frage"><Input value={question} maxLength={300} onChange={(e) => setQuestion(e.target.value)} placeholder="Was sollen wir als Nächstes spielen?" /></Field>
        <Field label="Antworten (2–10)">
          <div className="space-y-2">
            {answers.map((a, i) => (
              <div key={i} className="flex gap-2">
                <Input value={a} maxLength={55} placeholder={`Antwort ${i + 1}`} onChange={(e) => setAnswers(answers.map((x, j) => (j === i ? e.target.value : x)))} />
                {answers.length > 2 && <Button variant="ghost" onClick={() => setAnswers(answers.filter((_, j) => j !== i))}>×</Button>}
              </div>
            ))}
            {answers.length < 10 && <Button size="sm" onClick={() => setAnswers([...answers, ''])}>+ Antwort</Button>}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Laufzeit"><NumberInput value={hours} min={1} max={768} suffix="Std." onChange={setHours} /></Field>
          <div className="flex items-end pb-2"><Switch label="Mehrfachauswahl" checked={multi} onChange={setMulti} /></div>
        </div>
      </div>
    </Modal>
  );
}

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: LucideIcon | null;
  avatar?: string;
  run: () => void;
}

function CommandPalette({ open, onClose, actions, run }: { open: boolean; onClose: () => void; actions: QuickAction[]; run: (id: QuickAction['id']) => void }) {
  const guildId = useGuildId();
  const navigate = useNavigate();
  const { data: guild } = useGuild();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rank = guild ? ACCESS_RANK[guild.access] : 0;

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const { data: members } = useQuery({
    queryKey: ['palette-members', guildId, debounced],
    queryFn: () => api.get<{ items: { id: string; displayName: string; username: string; avatar: string }[] }>(`/guilds/${guildId}/members${qs({ query: debounced, limit: 6 })}`),
    enabled: open && debounced.length >= 2,
    staleTime: 30_000,
  });

  const items = useMemo<PaletteItem[]>(() => {
    const term = q.toLowerCase();
    const match = (...s: (string | undefined)[]) => !term || s.some((x) => x?.toLowerCase().includes(term));
    const pages = ALL_NAV_ITEMS.filter((i) => rank >= ACCESS_RANK[i.min] && match(i.label, i.keywords)).map((i) => ({
      id: `page-${i.to}`,
      group: 'Seiten',
      label: i.label,
      icon: i.icon,
      run: () => navigate(`/guild/${guildId}${i.to ? `/${i.to}` : ''}`),
    }));
    const acts = actions.filter((a) => match(a.label, a.description)).map((a) => ({ id: `act-${a.id}`, group: 'Schnellaktionen', label: a.label, hint: a.description, icon: a.icon, run: () => run(a.id) }));
    const mem = (members?.items ?? []).map((m) => ({
      id: `mem-${m.id}`,
      group: 'Mitglieder',
      label: m.displayName,
      hint: `@${m.username}`,
      icon: null,
      avatar: m.avatar,
      run: () => navigate(`/guild/${guildId}/members?user=${m.id}`),
    }));
    return [...pages, ...acts, ...(debounced.length >= 2 ? mem : [])];
  }, [q, rank, actions, members, debounced, guildId, navigate, run]);

  useEffect(() => setActive(0), [q]);
  const exec = (i: PaletteItem) => {
    onClose();
    i.run();
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[70] flex items-start justify-center p-4 pt-[12vh]">
          <motion.div className="absolute inset-0 bg-black/60" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div initial={{ opacity: 0, y: -10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10, scale: 0.98 }} transition={{ duration: 0.16 }} className="card relative w-full max-w-xl overflow-hidden bg-panel shadow-[0_30px_80px_-20px_rgb(0_0_0/0.8)]">
            <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
              <Search className="h-5 w-5 text-brand-300" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') onClose();
                  if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(a + 1, items.length - 1)));
                  if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
                  if (e.key === 'Enter' && items[active]) exec(items[active]);
                }}
                placeholder="Seiten, Aktionen oder Mitglieder suchen …"
                className="flex-1 bg-transparent text-[15px] outline-none placeholder:text-fg-subtle"
              />
              <span className="kbd">ESC</span>
            </div>
            <div className="max-h-[50vh] overflow-y-auto p-2">
              {items.length === 0 && <div className="px-4 py-10 text-center text-sm text-fg-subtle">Keine Treffer für „{q}“</div>}
              {items.map((it, idx) => (
                <div key={it.id}>
                  {(idx === 0 || items[idx - 1]!.group !== it.group) && <div className="px-3 pt-3 pb-1.5 text-[10px] font-semibold tracking-[0.12em] text-fg-subtle uppercase">{it.group}</div>}
                  <button
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => exec(it)}
                    className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors', idx === active ? 'bg-gradient-to-r from-brand-500/20 to-accent-500/5 text-fg ring-1 ring-brand-500/30' : 'text-fg-muted')}
                  >
                    {it.avatar ? <Avatar src={it.avatar} name={it.label} size={22} /> : it.icon ? <it.icon className={cn('h-4 w-4', idx === active ? 'text-brand-300' : 'text-fg-subtle')} /> : <User className="h-4 w-4" />}
                    <span className="flex-1 truncate">{it.label}</span>
                    {it.hint && <span className="truncate text-xs text-fg-subtle">{it.hint}</span>}
                    {idx === active && <CornerDownLeft className="h-3.5 w-3.5 text-fg-subtle" />}
                  </button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-fg-subtle">
              <span><span className="kbd">↑</span> <span className="kbd">↓</span> navigieren</span>
              <span><span className="kbd">↵</span> öffnen</span>
              <span className="ml-auto">Mitglieder ab 2 Zeichen</span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** Stellt Schnellaktionen, globale Suche (Strg/⌘ + K) und die zugehörigen Dialoge bereit. */
export function QuickActionsProvider({ children }: { children: ReactNode }) {
  const guildId = useGuildId();
  const navigate = useNavigate();
  const { data: guild } = useGuild();
  const [palette, setPalette] = useState(false);
  const [poll, setPoll] = useState(false);
  const [mod, setMod] = useState(false);
  const rank = guild ? ACCESS_RANK[guild.access] : 0;
  const actions = useMemo(
    () => QUICK_ACTIONS.filter((a) => rank >= ACCESS_RANK[a.min] && !(a.id === 'giveaway' && guild && !guild.modules.giveaways)),
    [rank, guild],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const run = useCallback(
    (id: QuickAction['id']) => {
      const base = `/guild/${guildId}`;
      if (id === 'giveaway') navigate(`${base}/giveaways?new=1`);
      if (id === 'poll') setPoll(true);
      if (id === 'message') navigate(`${base}/messages`);
      if (id === 'automation') navigate(`${base}/automations?new=1`);
      if (id === 'modaction') setMod(true);
      if (id === 'analytics') navigate(`${base}/analytics`);
    },
    [guildId, navigate],
  );

  return (
    <QuickCtx.Provider value={{ run, openPalette: () => setPalette(true), actions }}>
      {children}
      <CommandPalette open={palette} onClose={() => setPalette(false)} actions={actions} run={run} />
      <QuickPollModal open={poll} onClose={() => setPoll(false)} />
      {mod && <ModActionModal open onClose={() => setMod(false)} />}
    </QuickCtx.Provider>
  );
}

/** Dropdown „Schnellaktionen“ in der Topbar. */
export function QuickActionsMenu() {
  const { actions, run } = useQuickActions();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-xl border border-brand-500/30 bg-gradient-to-b from-brand-500/20 to-brand-600/10 px-3 py-2 text-sm font-medium text-brand-300 transition hover:from-brand-500/30" aria-label="Schnellaktionen">
        <Zap className="h-4 w-4" />
        <span className="hidden md:inline">Aktionen</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.14 }} className="card absolute right-0 z-50 mt-2 w-72 bg-panel p-1.5 shadow-2xl">
            {actions.map((a) => (
              <button key={a.id} onClick={() => (setOpen(false), run(a.id))} className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-white/[0.04]">
                <div className="rounded-lg bg-brand-500/10 p-2 text-brand-300 ring-1 ring-brand-500/20 transition group-hover:bg-brand-500/20"><a.icon className="h-4 w-4" /></div>
                <div className="flex-1">
                  <div className="text-sm font-medium">{a.label}</div>
                  <div className="text-xs text-fg-subtle">{a.description}</div>
                </div>
                <ArrowRight className="h-4 w-4 -translate-x-1 text-fg-subtle opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
