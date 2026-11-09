import { useId } from 'react';
import { cn } from '../../lib/format';

/** Discord-OS-Bildmarke: stilisierter Kern mit Orbit, elektrisches Blau → Violett. */
export function LogoMark({ size = 36, className }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={cn('shrink-0', className)} aria-label="Discord OS">
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4350f0" />
          <stop offset="0.55" stopColor="#6d4dff" />
          <stop offset="1" stopColor="#a855f7" />
        </linearGradient>
        <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.35" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#${id}-bg)`} />
      <rect width="64" height="64" rx="16" fill={`url(#${id}-shine)`} />
      <ellipse cx="32" cy="32" rx="22" ry="9" fill="none" stroke="#fff" strokeOpacity="0.45" strokeWidth="2" transform="rotate(-30 32 32)" />
      <circle cx="32" cy="32" r="10" fill="#fff" />
      <circle cx="32" cy="32" r="4.5" fill="#5865ff" />
      <circle cx="50" cy="20" r="3" fill="#7dd3fc" />
    </svg>
  );
}

export function Logo({ collapsed }: { collapsed?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative">
        <div className="absolute inset-0 rounded-xl bg-brand-500/50 blur-md" />
        <LogoMark size={36} className="relative" />
      </div>
      {!collapsed && (
        <div className="leading-tight">
          <div className="text-[15px] font-bold tracking-[0.14em]">
            DISCORD <span className="gradient-text">OS</span>
          </div>
          <div className="text-[10px] tracking-[0.18em] text-fg-subtle uppercase">Control Center</div>
        </div>
      )}
    </div>
  );
}
