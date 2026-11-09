import { AnimatePresence, motion } from 'framer-motion';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/format';

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
}

/** Kontextmenü (⋯) für Aktionen an Karten und Tabellenzeilen. */
export function ActionMenu({ items, className }: { items: MenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const visible = items.filter((i) => !i.hidden);
  if (!visible.length) return null;
  return (
    <div ref={ref} className={cn('relative', className)} onClick={(e) => e.stopPropagation()}>
      <button onClick={() => setOpen((o) => !o)} className="rounded-lg p-1.5 text-fg-subtle transition hover:bg-white/[0.06] hover:text-fg" aria-label="Aktionen">
        <MoreHorizontal className="h-4 w-4" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, scale: 0.96, y: -4 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: -4 }} transition={{ duration: 0.12 }} className="card absolute right-0 z-40 mt-1 w-52 origin-top-right bg-panel p-1 shadow-2xl">
            {visible.map((i) => (
              <button
                key={i.label}
                disabled={i.disabled}
                onClick={() => {
                  setOpen(false);
                  i.onClick();
                }}
                className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition disabled:opacity-40', i.danger ? 'text-red-300 hover:bg-red-500/10' : 'text-fg-muted hover:bg-white/[0.05] hover:text-fg')}
              >
                {i.icon && <i.icon className="h-4 w-4" />}
                {i.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
