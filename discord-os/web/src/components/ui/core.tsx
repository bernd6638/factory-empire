import { motion } from 'framer-motion';
import { ChevronDown, Loader2, type LucideIcon } from 'lucide-react';
import { forwardRef, useEffect, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/format';

// ─── Button ───
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-gradient-to-b from-brand-500 to-brand-600 text-white shadow-[0_8px_24px_-10px_rgb(99_102_241/0.8)] hover:from-brand-400 hover:to-brand-500 border border-brand-400/30',
  secondary: 'bg-panel-3 text-fg border border-line-strong hover:bg-[#2a2f3a]',
  ghost: 'text-fg-muted hover:text-fg hover:bg-panel-3',
  danger: 'bg-red-500/10 text-red-300 border border-red-500/30 hover:bg-red-500/20',
  success: 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg' | 'icon';
  loading?: boolean;
  icon?: LucideIcon;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', loading, icon: Icon, className, children, disabled, ...rest }, ref) {
  const sizes = { sm: 'h-8 px-3 text-xs gap-1.5', md: 'h-10 px-4 text-sm gap-2', lg: 'h-12 px-6 text-base gap-2', icon: 'h-9 w-9 justify-center' };
  return (
    <button
      ref={ref}
      className={cn('inline-flex shrink-0 items-center justify-center rounded-xl font-medium transition-all duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50', VARIANTS[variant], sizes[size], className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : Icon ? <Icon className="h-4 w-4" /> : null}
      {children}
    </button>
  );
});

// ─── Card ───
export function Card({ className, children, delay = 0, hover }: { className?: string; children: ReactNode; delay?: number; hover?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: [0.22, 1, 0.36, 1] }}
      className={cn('card', hover && 'transition-colors hover:border-line-strong', className)}
    >
      {children}
    </motion.div>
  );
}

export function CardHeader({ title, description, icon: Icon, actions, className }: { title: ReactNode; description?: ReactNode; icon?: LucideIcon; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-line/70 px-5 py-4', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {Icon && (
          <div className="mt-0.5 rounded-lg bg-brand-500/10 p-2 text-brand-300 ring-1 ring-brand-500/20">
            <Icon className="h-4 w-4" />
          </div>
        )}
        <div className="min-w-0">
          <h3 className="font-semibold text-fg">{title}</h3>
          {description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// ─── Formular ───
export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      {label && <label className="label">{label}</label>}
      {children}
      {error ? <p className="mt-1 text-xs text-red-400">{error}</p> : hint ? <p className="mt-1 text-xs text-fg-subtle">{hint}</p> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn('input', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn('input min-h-[96px] resize-y leading-relaxed', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cn('relative', className)}>
      <select className="input cursor-pointer appearance-none pr-9" {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
    </div>
  );
}

export function NumberInput({ value, onChange, min, max, step = 1, className, suffix }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; className?: string; suffix?: string }) {
  return (
    <div className={cn('relative', className)}>
      <input
        type="number"
        className={cn('input', suffix && 'pr-14')}
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = e.target.value === '' ? (min ?? 0) : Number(e.target.value);
          onChange(Number.isFinite(v) ? v : (min ?? 0));
        }}
      />
      {suffix && <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-fg-subtle">{suffix}</span>}
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label, description }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: ReactNode; description?: ReactNode }) {
  const id = useId();
  const toggle = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50', checked ? 'border-brand-400/50 bg-brand-500' : 'border-line-strong bg-panel-3')}
    >
      <motion.span layout transition={{ type: 'spring', stiffness: 600, damping: 35 }} className={cn('inline-block h-4.5 w-4.5 rounded-full bg-white shadow', checked ? 'ml-[22px]' : 'ml-[3px]')} />
    </button>
  );
  if (!label) return toggle;
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <label htmlFor={id} className="cursor-pointer">
        <div className="text-sm font-medium text-fg">{label}</div>
        {description && <div className="mt-0.5 text-xs text-fg-muted">{description}</div>}
      </label>
      {toggle}
    </div>
  );
}

// ─── Anzeige ───
const BADGE: Record<string, string> = {
  gray: 'bg-white/5 text-fg-muted ring-white/10',
  brand: 'bg-brand-500/10 text-brand-300 ring-brand-500/25',
  violet: 'bg-accent-500/10 text-accent-400 ring-accent-500/25',
  green: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/25',
  yellow: 'bg-amber-500/10 text-amber-300 ring-amber-500/25',
  red: 'bg-red-500/10 text-red-300 ring-red-500/25',
  blue: 'bg-sky-500/10 text-sky-300 ring-sky-500/25',
};

export function Badge({ color = 'gray', children, className, dot }: { color?: keyof typeof BADGE; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset', BADGE[color], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-brand-400', className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-panel-3/70', className)} />;
}

export function LoadingBlock({ label = 'Lädt …', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-center gap-3 py-16 text-sm text-fg-muted', className)}>
      <Spinner /> {label}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-4 rounded-2xl bg-gradient-to-br from-brand-500/15 to-accent-500/10 p-4 ring-1 ring-brand-500/20">
        <Icon className="h-6 w-6 text-brand-300" />
      </div>
      <h4 className="font-semibold">{title}</h4>
      {description && <p className="mt-1 max-w-sm text-sm text-fg-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Unbekannter Fehler';
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 px-6 py-8 text-center">
      <p className="text-sm text-red-300">{msg}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Erneut versuchen
        </Button>
      )}
    </div>
  );
}

export function Avatar({ src, name, size = 36, className }: { src?: string | null; name?: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? (
    <img src={src} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} className={cn('shrink-0 rounded-full bg-panel-3 object-cover ring-1 ring-white/10', className)} style={{ width: size, height: size }} />
  ) : (
    <div className={cn('flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-accent-500 font-semibold text-white', className)} style={{ width: size, height: size, fontSize: size * 0.4 }} aria-label={name}>
      {(name ?? '?').slice(0, 1).toUpperCase()}
    </div>
  );
}

export function PageHeader({ title, description, icon: Icon, actions }: { title: string; description?: ReactNode; icon?: LucideIcon; actions?: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="flex items-center gap-4">
        {Icon && (
          <div className="hidden rounded-2xl bg-gradient-to-br from-brand-500/20 to-accent-500/10 p-3 ring-1 ring-brand-500/25 sm:block">
            <Icon className="h-6 w-6 text-brand-300" />
          </div>
        )}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">{title}</h1>
          {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </motion.div>
  );
}

export function StatCard({ label, value, icon: Icon, hint, accent = 'brand', delay = 0, live }: { label: string; value: ReactNode; icon: LucideIcon; hint?: ReactNode; accent?: 'brand' | 'violet' | 'green' | 'yellow' | 'red' | 'blue'; delay?: number; live?: boolean }) {
  const accents = {
    brand: 'from-brand-500/20 text-brand-300 ring-brand-500/25',
    violet: 'from-accent-500/20 text-accent-400 ring-accent-500/25',
    green: 'from-emerald-500/20 text-emerald-300 ring-emerald-500/25',
    yellow: 'from-amber-500/20 text-amber-300 ring-amber-500/25',
    red: 'from-red-500/20 text-red-300 ring-red-500/25',
    blue: 'from-sky-500/20 text-sky-300 ring-sky-500/25',
  };
  return (
    <Card delay={delay} hover className="relative overflow-hidden p-5">
      <div className="pointer-events-none absolute -top-12 -right-12 h-40 w-40 rounded-full bg-[radial-gradient(circle,rgb(99_102_241/0.12),transparent_70%)]" />
      <div className="flex items-start justify-between">
        <div>
          <p className="flex items-center gap-2 text-xs font-medium tracking-wide text-fg-muted uppercase">
            {label}
            {live && <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-emerald-400" />}
          </p>
          <p className="mt-2 text-[28px] leading-none font-semibold tracking-tight tabular-nums">{value}</p>
          {hint && <p className="mt-2 text-xs text-fg-subtle">{hint}</p>}
        </div>
        <div className={cn('rounded-xl bg-gradient-to-br to-transparent p-2.5 ring-1', accents[accent])}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </Card>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: string; icon?: LucideIcon; badge?: ReactNode }[]; value: T; onChange: (id: T) => void; className?: string }) {
  return (
    <div className={cn('-mx-1 mb-5 flex gap-1 overflow-x-auto px-1 pb-1', className)}>
      <div className="flex gap-1 rounded-xl border border-line bg-panel/70 p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={cn('relative flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium whitespace-nowrap transition-colors', value === t.id ? 'text-fg' : 'text-fg-muted hover:text-fg')}
          >
            {value === t.id && <motion.span layoutId={`tab-${tabs.map((x) => x.id).join('')}`} className="absolute inset-0 rounded-lg bg-panel-3 ring-1 ring-line-strong" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
            <span className="relative flex items-center gap-2">
              {t.icon && <t.icon className="h-4 w-4" />}
              {t.label}
              {t.badge}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Pagination({ page, total, limit, onChange }: { page: number; total: number; limit: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3 text-sm text-fg-muted">
      <span>
        Seite {page} von {pages} · {total.toLocaleString('de-DE')} Einträge
      </span>
      <div className="flex gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          Zurück
        </Button>
        <Button size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          Weiter
        </Button>
      </div>
    </div>
  );
}

export function KeyValue({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line/50 py-2.5 text-sm last:border-0">
      <span className="text-fg-muted">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
