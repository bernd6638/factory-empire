import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/format';
import { Button, Input } from './core';

// ─── Modal ───
export function Modal({ open, onClose, title, description, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);
  const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' };
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
          <motion.div className="absolute inset-0 bg-black/60 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal="true"
            className={cn('card relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-b-none bg-panel sm:rounded-2xl', widths[size])}
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }}
          >
            <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold">{title}</h2>
                {description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
              </div>
              <button onClick={onClose} className="rounded-lg p-1.5 text-fg-muted transition hover:bg-panel-3 hover:text-fg" aria-label="Schließen">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-y-auto px-6 py-5">{children}</div>
            {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-panel-2/50 px-6 py-4">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

// ─── Toasts ───
type ToastKind = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}
const ToastCtx = createContext<(kind: ToastKind, message: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const push = useCallback((kind: ToastKind, message: string) => {
    const id = ++idRef.current;
    setToasts((t) => [...t.slice(-4), { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  const icons = { success: CheckCircle2, error: XCircle, info: Info };
  const colors = { success: 'text-emerald-400', error: 'text-red-400', info: 'text-brand-300' };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2">
          <AnimatePresence>
            {toasts.map((t) => {
              const Icon = icons[t.kind];
              return (
                <motion.div
                  key={t.id}
                  layout
                  initial={{ opacity: 0, x: 40, scale: 0.96 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: 40, scale: 0.96 }}
                  className="card pointer-events-auto flex items-start gap-3 bg-panel-2 px-4 py-3 shadow-2xl"
                >
                  <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', colors[t.kind])} />
                  <p className="flex-1 text-sm">{t.message}</p>
                  <button onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))} className="text-fg-subtle hover:text-fg">
                    <X className="h-4 w-4" />
                  </button>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastCtx);
  return {
    success: (m: string) => push('success', m),
    error: (e: unknown) => push('error', e instanceof Error ? e.message : String(e)),
    info: (m: string) => push('info', m),
  };
}

// ─── Bestätigungsdialog ───
interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** Nutzer muss diesen Text eintippen */
  typeToConfirm?: string;
}
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState('');
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => {
    setTyped('');
    setState({ ...o, resolve });
  }), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal
        open={!!state}
        onClose={() => close(false)}
        size="sm"
        title={
          <span className="flex items-center gap-2">
            {state?.danger && <AlertTriangle className="h-5 w-5 text-red-400" />}
            {state?.title}
          </span>
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Abbrechen
            </Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} disabled={!!state?.typeToConfirm && typed !== state.typeToConfirm} onClick={() => close(true)}>
              {state?.confirmLabel ?? 'Bestätigen'}
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm text-fg-muted">
          {state?.message}
          {state?.typeToConfirm && (
            <div>
              <p className="mb-2">
                Tippe <code className="rounded bg-panel-3 px-1.5 py-0.5 text-fg">{state.typeToConfirm}</code> zur Bestätigung:
              </p>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </div>
          )}
        </div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmCtx);
}
