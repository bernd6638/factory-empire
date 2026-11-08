import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { ACCESS_RANK, type AccessName, type Channel, type GuildDetail, type ModuleConfigs, type ModuleKey, type Role } from '../lib/types';
import { useToast } from '../components/ui/overlay';

export function useGuildId(): string {
  const { guildId } = useParams();
  return guildId ?? '';
}

export function useGuild() {
  const guildId = useGuildId();
  return useQuery({ queryKey: ['guild', guildId], queryFn: () => api.get<GuildDetail>(`/guilds/${guildId}`), enabled: !!guildId, staleTime: 30_000 });
}

/** Prüft, ob der aktuelle Nutzer mindestens die angegebene Stufe hat. */
export function useCan(min: AccessName) {
  const { data } = useGuild();
  return data ? ACCESS_RANK[data.access] >= ACCESS_RANK[min] : false;
}

export function useChannels() {
  const guildId = useGuildId();
  return useQuery({ queryKey: ['channels', guildId], queryFn: () => api.get<Channel[]>(`/guilds/${guildId}/server/channels`), enabled: !!guildId, staleTime: 60_000, retry: 1 });
}

export function useRoles() {
  const guildId = useGuildId();
  return useQuery({ queryKey: ['roles', guildId], queryFn: () => api.get<Role[]>(`/guilds/${guildId}/server/roles`), enabled: !!guildId, staleTime: 60_000, retry: 1 });
}

/** Lookup-Funktionen für Namen von Kanälen und Rollen. */
export function useLookup() {
  const { data: channels } = useChannels();
  const { data: roles } = useRoles();
  return useMemo(() => {
    const ch = new Map((channels ?? []).map((c) => [c.id, c]));
    const ro = new Map((roles ?? []).map((r) => [r.id, r]));
    return {
      channel: (id?: string | null) => (id ? ch.get(id) : undefined),
      channelName: (id?: string | null) => (id ? (ch.get(id) ? `#${ch.get(id)!.name}` : `#${id}`) : '—'),
      role: (id?: string | null) => (id ? ro.get(id) : undefined),
      roleName: (id?: string | null) => (id ? (ro.get(id)?.name ?? id) : '—'),
    };
  }, [channels, roles]);
}

interface ModuleResponse<K extends ModuleKey> {
  key: K;
  enabled: boolean;
  config: ModuleConfigs[K];
  defaults: ModuleConfigs[K];
  updatedAt: string | null;
}

/**
 * Lädt die Einstellungen eines Moduls und verwaltet einen lokalen Entwurf.
 * `dirty` zeigt ungespeicherte Änderungen an; `save()` speichert dauerhaft in der Datenbank.
 */
export function useModuleConfig<K extends ModuleKey>(key: K) {
  const guildId = useGuildId();
  const qc = useQueryClient();
  const toast = useToast();
  const query = useQuery({ queryKey: ['module', guildId, key], queryFn: () => api.get<ModuleResponse<K>>(`/guilds/${guildId}/modules/${key}`), enabled: !!guildId });
  const [draft, setDraft] = useState<ModuleConfigs[K] | null>(null);

  useEffect(() => {
    if (query.data) setDraft(structuredClone(query.data.config));
  }, [query.data]);

  const dirty = useMemo(() => !!draft && !!query.data && JSON.stringify(draft) !== JSON.stringify(query.data.config), [draft, query.data]);

  const update = useCallback((mutate: (cfg: ModuleConfigs[K]) => void) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      mutate(next);
      return next;
    });
  }, []);

  const saveMutation = useMutation({
    mutationFn: (body: { enabled?: boolean; config?: ModuleConfigs[K] }) => api.put<ModuleResponse<K>>(`/guilds/${guildId}/modules/${key}`, body),
    onSuccess: (res, vars) => {
      qc.setQueryData(['module', guildId, key], (old: ModuleResponse<K> | undefined) => (old ? { ...old, ...res } : old));
      void qc.invalidateQueries({ queryKey: ['guild', guildId] });
      void qc.invalidateQueries({ queryKey: ['modules', guildId] });
      toast.success(vars.config ? 'Einstellungen gespeichert' : res.enabled ? 'Modul aktiviert' : 'Modul deaktiviert');
    },
    onError: (e) => toast.error(e),
  });

  return {
    isLoading: query.isLoading,
    error: query.error,
    enabled: query.data?.enabled ?? false,
    defaults: query.data?.defaults,
    config: draft,
    update,
    dirty,
    saving: saveMutation.isPending,
    save: () => draft && saveMutation.mutate({ config: draft }),
    reset: () => query.data && setDraft(structuredClone(query.data.config)),
    setEnabled: (enabled: boolean) => saveMutation.mutate({ enabled }),
  };
}
