import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import type { ModCase } from '../../lib/types';
import { useGuildId } from '../../hooks/guild';
import { Button, Field, Input, Select, Textarea } from '../ui/core';
import { Modal, useToast } from '../ui/overlay';

export type ModActionType = ModCase['type'];

export const CASE_LABEL: Record<ModActionType, string> = { WARN: 'Verwarnung', TIMEOUT: 'Timeout', UNTIMEOUT: 'Timeout aufheben', KICK: 'Kick', BAN: 'Bann', UNBAN: 'Entbannen', NOTE: 'Notiz' };
export const CASE_COLOR: Record<ModActionType, 'yellow' | 'red' | 'green' | 'blue' | 'gray'> = { WARN: 'yellow', TIMEOUT: 'yellow', UNTIMEOUT: 'green', KICK: 'red', BAN: 'red', UNBAN: 'green', NOTE: 'blue' };

const DURATIONS = [
  { label: '5 Minuten', v: 5 },
  { label: '10 Minuten', v: 10 },
  { label: '1 Stunde', v: 60 },
  { label: '6 Stunden', v: 360 },
  { label: '1 Tag', v: 1440 },
  { label: '1 Woche', v: 10080 },
  { label: '28 Tage', v: 40320 },
];

/** Dialog zum Ausführen einer Moderationsaktion über den Bot. */
export function ModActionModal({ open, onClose, userId: initialUser, username, initialType = 'WARN' }: { open: boolean; onClose: () => void; userId?: string; username?: string; initialType?: ModActionType }) {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<ModActionType>(initialType);
  const [userId, setUserId] = useState(initialUser ?? '');
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState(60);
  const [banTemp, setBanTemp] = useState(0);
  const [deleteSeconds, setDeleteSeconds] = useState(0);

  const run = useMutation({
    mutationFn: () =>
      api.post<ModCase>(`/guilds/${guildId}/moderation/actions`, {
        type,
        userId: userId.trim(),
        reason: reason || null,
        durationMinutes: type === 'TIMEOUT' ? duration : type === 'BAN' && banTemp ? banTemp : null,
        deleteMessageSeconds: type === 'BAN' ? deleteSeconds : undefined,
      }),
    onSuccess: (c) => {
      toast.success(`Fall #${c.caseNumber}: ${CASE_LABEL[c.type]} ausgeführt`);
      void qc.invalidateQueries({ queryKey: ['cases'] });
      void qc.invalidateQueries({ queryKey: ['member'] });
      void qc.invalidateQueries({ queryKey: ['members'] });
      setReason('');
      onClose();
    },
    onError: toast.error,
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Moderationsaktion"
      description={username ? `Für ${username}` : 'Die Aktion wird vom Bot ausgeführt und als Fall protokolliert.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant={['KICK', 'BAN'].includes(type) ? 'danger' : 'primary'} loading={run.isPending} disabled={!/^\d{15,22}$/.test(userId.trim())} onClick={() => run.mutate()}>
            {CASE_LABEL[type]} ausführen
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(['WARN', 'TIMEOUT', 'KICK', 'BAN', 'UNTIMEOUT', 'UNBAN', 'NOTE'] as ModActionType[]).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`rounded-xl border px-3 py-2 text-sm font-medium transition ${type === t ? 'border-brand-500/60 bg-brand-500/15 text-fg' : 'border-line bg-panel-2 text-fg-muted hover:text-fg'}`}
            >
              {CASE_LABEL[t]}
            </button>
          ))}
        </div>
        {!initialUser && (
          <Field label="User-ID" hint="Rechtsklick auf den Nutzer in Discord → „ID kopieren“ (Entwicklermodus).">
            <Input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="123456789012345678" />
          </Field>
        )}
        {type === 'TIMEOUT' && (
          <Field label="Dauer">
            <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
            </Select>
          </Field>
        )}
        {type === 'BAN' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Dauer">
              <Select value={banTemp} onChange={(e) => setBanTemp(Number(e.target.value))}>
                <option value={0}>Permanent</option>
                {DURATIONS.slice(2).map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
              </Select>
            </Field>
            <Field label="Nachrichten löschen">
              <Select value={deleteSeconds} onChange={(e) => setDeleteSeconds(Number(e.target.value))}>
                <option value={0}>Keine</option>
                <option value={3600}>Letzte Stunde</option>
                <option value={86400}>Letzte 24 Stunden</option>
                <option value={604800}>Letzte 7 Tage</option>
              </Select>
            </Field>
          </div>
        )}
        <Field label={type === 'NOTE' ? 'Notiz' : 'Begründung'}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={type === 'NOTE' ? 'Interne Notiz …' : 'Optional (je nach Einstellung erforderlich)'} />
        </Field>
      </div>
    </Modal>
  );
}
