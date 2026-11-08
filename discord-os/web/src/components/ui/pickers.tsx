import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown, Hash, Search, Shield, Volume2, X, Folder, Megaphone } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useChannels, useRoles } from '../../hooks/guild';
import { cn } from '../../lib/format';
import { CHANNEL_TYPE, type Channel, type Role } from '../../lib/types';

type ChannelKind = 'text' | 'voice' | 'category';
const KIND_TYPES: Record<ChannelKind, number[]> = {
  text: [CHANNEL_TYPE.TEXT, CHANNEL_TYPE.ANNOUNCEMENT],
  voice: [CHANNEL_TYPE.VOICE, CHANNEL_TYPE.STAGE],
  category: [CHANNEL_TYPE.CATEGORY],
};

export function ChannelIcon({ type, className = 'h-4 w-4' }: { type: number; className?: string }) {
  if (type === CHANNEL_TYPE.VOICE || type === CHANNEL_TYPE.STAGE) return <Volume2 className={className} />;
  if (type === CHANNEL_TYPE.CATEGORY) return <Folder className={className} />;
  if (type === CHANNEL_TYPE.ANNOUNCEMENT) return <Megaphone className={className} />;
  return <Hash className={className} />;
}

interface Option {
  id: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  color?: string;
  disabled?: boolean;
}

/** Durchsuchbares Dropdown (einfach oder mehrfach). */
function Picker({ options, value, onChange, multiple, placeholder, allowClear, loading }: { options: Option[]; value: string[]; onChange: (v: string[]) => void; multiple?: boolean; placeholder: string; allowClear?: boolean; loading?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
    else setQ('');
  }, [open]);
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const filtered = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()) || o.id === q);
  const select = (id: string) => {
    if (multiple) onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
    else {
      onChange([id]);
      setOpen(false);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    if (e.key === 'Enter' && filtered[0]) {
      e.preventDefault();
      select(filtered[0].id);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn('input flex min-h-[40px] items-center gap-2 text-left', open && 'border-brand-500/70 ring-2 ring-brand-500/25')}
      >
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          {value.length === 0 && <span className="text-fg-subtle">{loading ? 'Lädt …' : placeholder}</span>}
          {!multiple && value[0] && (
            <span className="flex items-center gap-2 truncate">
              {byId.get(value[0])?.icon}
              <span style={{ color: byId.get(value[0])?.color }}>{byId.get(value[0])?.label ?? `Unbekannt (${value[0]})`}</span>
            </span>
          )}
          {multiple &&
            value.map((id) => (
              <span key={id} className="flex items-center gap-1 rounded-md bg-panel-3 py-0.5 pr-1 pl-2 text-xs ring-1 ring-line-strong">
                <span style={{ color: byId.get(id)?.color }}>{byId.get(id)?.label ?? id}</span>
                <span
                  role="button"
                  tabIndex={-1}
                  className="rounded p-0.5 text-fg-subtle hover:bg-panel hover:text-fg"
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(value.filter((v) => v !== id));
                  }}
                >
                  <X className="h-3 w-3" />
                </span>
              </span>
            ))}
        </div>
        {allowClear && !multiple && value[0] ? (
          <span
            role="button"
            tabIndex={-1}
            className="rounded p-0.5 text-fg-subtle hover:text-fg"
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
          >
            <X className="h-4 w-4" />
          </span>
        ) : (
          <ChevronDown className={cn('h-4 w-4 shrink-0 text-fg-subtle transition', open && 'rotate-180')} />
        )}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute z-40 mt-1.5 w-full min-w-[220px] overflow-hidden rounded-xl border border-line-strong bg-panel-2 shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <Search className="h-4 w-4 text-fg-subtle" />
              <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Suchen …" className="w-full bg-transparent text-sm outline-none placeholder:text-fg-subtle" />
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {filtered.length === 0 && <div className="px-3 py-4 text-center text-sm text-fg-subtle">Keine Treffer</div>}
              {filtered.map((o) => {
                const selected = value.includes(o.id);
                return (
                  <button
                    type="button"
                    key={o.id}
                    disabled={o.disabled}
                    onClick={() => select(o.id)}
                    className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition disabled:opacity-40', selected ? 'bg-brand-500/15 text-fg' : 'text-fg-muted hover:bg-panel-3 hover:text-fg')}
                  >
                    <span className="text-fg-subtle">{o.icon}</span>
                    <span className="flex-1 truncate" style={{ color: o.color }}>
                      {o.label}
                    </span>
                    {o.hint && <span className="text-[11px] text-fg-subtle">{o.hint}</span>}
                    {selected && <Check className="h-4 w-4 text-brand-300" />}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function channelOptions(channels: Channel[] | undefined, kinds: ChannelKind[]): Option[] {
  if (!channels) return [];
  const types = kinds.flatMap((k) => KIND_TYPES[k]);
  const cats = new Map(channels.filter((c) => c.type === CHANNEL_TYPE.CATEGORY).map((c) => [c.id, c.name]));
  return channels
    .filter((c) => types.includes(c.type))
    .map((c) => ({
      id: c.id,
      label: c.name,
      hint: c.parentId ? cats.get(c.parentId) : undefined,
      icon: <ChannelIcon type={c.type} />,
      disabled: false,
    }));
}

function roleOptions(roles: Role[] | undefined, opts: { includeEveryone?: boolean; onlyAssignable?: boolean }): Option[] {
  return (roles ?? [])
    .filter((r) => (opts.includeEveryone || !r.everyone) && !r.managed)
    .map((r) => ({
      id: r.id,
      label: r.everyone ? '@everyone' : r.name,
      color: r.color !== '#000000' ? r.color : undefined,
      icon: <Shield className="h-4 w-4" />,
      hint: opts.onlyAssignable && !r.editable ? 'nicht vergebbar' : undefined,
      disabled: opts.onlyAssignable ? !r.editable : false,
    }));
}

export function ChannelSelect({ value, onChange, kinds = ['text'], placeholder = 'Kanal wählen …', allowClear = true }: { value: string | null; onChange: (v: string | null) => void; kinds?: ChannelKind[]; placeholder?: string; allowClear?: boolean }) {
  const { data, isLoading } = useChannels();
  return <Picker options={channelOptions(data, kinds)} value={value ? [value] : []} onChange={(v) => onChange(v[0] ?? null)} placeholder={placeholder} allowClear={allowClear} loading={isLoading} />;
}

export function MultiChannelSelect({ value, onChange, kinds = ['text'], placeholder = 'Kanäle wählen …' }: { value: string[]; onChange: (v: string[]) => void; kinds?: ChannelKind[]; placeholder?: string }) {
  const { data, isLoading } = useChannels();
  return <Picker multiple options={channelOptions(data, kinds)} value={value} onChange={onChange} placeholder={placeholder} loading={isLoading} />;
}

export function RoleSelect({ value, onChange, placeholder = 'Rolle wählen …', assignable, includeEveryone, allowClear = true }: { value: string | null; onChange: (v: string | null) => void; placeholder?: string; assignable?: boolean; includeEveryone?: boolean; allowClear?: boolean }) {
  const { data, isLoading } = useRoles();
  return <Picker options={roleOptions(data, { onlyAssignable: assignable, includeEveryone })} value={value ? [value] : []} onChange={(v) => onChange(v[0] ?? null)} placeholder={placeholder} allowClear={allowClear} loading={isLoading} />;
}

export function MultiRoleSelect({ value, onChange, placeholder = 'Rollen wählen …', assignable }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; assignable?: boolean }) {
  const { data, isLoading } = useRoles();
  return <Picker multiple options={roleOptions(data, { onlyAssignable: assignable })} value={value} onChange={onChange} placeholder={placeholder} loading={isLoading} />;
}

/** Eingabe einer Liste von Texten (Enter oder Komma fügt hinzu). */
export function TagInput({ value, onChange, placeholder = 'Eintrag eingeben und Enter drücken', max = 500 }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; max?: number }) {
  const [text, setText] = useState('');
  const add = () => {
    const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    onChange([...new Set([...value, ...parts])].slice(0, max));
    setText('');
  };
  return (
    <div className="input flex min-h-[40px] flex-wrap items-center gap-1.5">
      {value.map((t) => (
        <span key={t} className="flex items-center gap-1 rounded-md bg-panel-3 py-0.5 pr-1 pl-2 text-xs ring-1 ring-line-strong">
          {t}
          <button type="button" className="rounded p-0.5 text-fg-subtle hover:text-fg" onClick={() => onChange(value.filter((v) => v !== t))}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
        placeholder={value.length ? '' : placeholder}
        className="min-w-[140px] flex-1 bg-transparent text-sm outline-none placeholder:text-fg-subtle"
      />
    </div>
  );
}
