import { AnimatePresence, motion } from 'framer-motion';
import { PowerOff, RotateCcw, Save } from 'lucide-react';
import { useCan } from '../../hooks/guild';
import { Button, Switch } from './core';

/** Schwebende Leiste bei ungespeicherten Änderungen. */
export function SaveBar({ dirty, saving, onSave, onReset }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void }) {
  const canEdit = useCan('ADMIN');
  return (
    <AnimatePresence>
      {dirty && canEdit && (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 32 }}
          className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 lg:pl-72"
        >
          <div className="card flex w-full max-w-2xl items-center justify-between gap-3 bg-panel-2/95 px-4 py-3 shadow-glow">
            <span className="text-sm text-fg-muted">
              <span className="mr-2 inline-block h-2 w-2 animate-pulse-soft rounded-full bg-amber-400" />
              Ungespeicherte Änderungen
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" icon={RotateCcw} onClick={onReset}>
                Verwerfen
              </Button>
              <Button size="sm" variant="primary" icon={Save} loading={saving} onClick={onSave}>
                Speichern
              </Button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Kopfzeile mit Modul-Schalter; zeigt Hinweis, wenn das Modul deaktiviert ist. */
export function ModuleToggle({ name, enabled, onChange, saving }: { name: string; enabled: boolean; onChange: (v: boolean) => void; saving?: boolean }) {
  const canEdit = useCan('ADMIN');
  return (
    <div className="space-y-3">
      <div className="card flex items-center justify-between gap-4 px-5 py-4">
        <div>
          <div className="font-medium">Modul „{name}“</div>
          <div className="text-sm text-fg-muted">{enabled ? 'Aktiv – der Bot reagiert auf Ereignisse und Befehle.' : 'Deaktiviert – Befehle und automatische Aktionen sind ausgeschaltet.'}</div>
        </div>
        <Switch checked={enabled} onChange={onChange} disabled={!canEdit || saving} />
      </div>
      {!enabled && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
          <PowerOff className="h-4 w-4 shrink-0" />
          Dieses Modul ist deaktiviert. Einstellungen können trotzdem vorbereitet und gespeichert werden.
        </div>
      )}
    </div>
  );
}
