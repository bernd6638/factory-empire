import { motion } from 'framer-motion';
import { ArrowRight, Plus, RefreshCw, Search, ServerOff } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { GuildListItem } from '../lib/types';
import { Avatar, Badge, Button, EmptyState, ErrorState, Input, Skeleton } from '../components/ui/core';
import { BotStatusPill } from '../components/layout/AppLayout';
import { useMe } from '../components/layout/AuthGate';
import { LogoMark } from '../components/layout/Logo';

const ACCESS_LABEL = { OWNER: 'Besitzer', ADMIN: 'Admin', MODERATOR: 'Moderator', VIEWER: 'Betrachter', NONE: '' } as const;

export function ServersPage() {
  const { data: me } = useMe();
  const [q, setQ] = useState('');
  const [refresh, setRefresh] = useState(0);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['guilds', refresh],
    queryFn: () => api.get<GuildListItem[]>(`/guilds${refresh ? '?refresh=1' : ''}`),
  });
  const list = (data ?? []).filter((g) => g.name.toLowerCase().includes(q.toLowerCase()));
  const withBot = list.filter((g) => g.botPresent);
  const withoutBot = list.filter((g) => !g.botPresent);

  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    location.href = '/login';
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:py-12">
      <div className="mb-10 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <LogoMark size={40} />
          <div>
            <div className="font-bold tracking-[0.14em]">DISCORD <span className="gradient-text">OS</span></div>
            <div className="text-xs text-fg-subtle">Angemeldet als {me?.globalName ?? me?.username}</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <BotStatusPill />
          <Button size="sm" variant="ghost" onClick={logout}>
            Abmelden
          </Button>
        </div>
      </div>

      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Server auswählen</h1>
          <p className="mt-1 text-fg-muted">Server, auf denen du „Server verwalten“ besitzt oder Dashboard-Zugriff erhalten hast.</p>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <div className="relative flex-1 sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
            <Input placeholder="Server suchen …" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          <Button icon={RefreshCw} loading={isFetching} onClick={() => (refresh ? refetch() : setRefresh(1))} title="Serverliste von Discord neu laden" />
        </div>
      </motion.div>

      {error && <ErrorState error={error} onRetry={() => refetch()} />}
      {isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-2xl" />
          ))}
        </div>
      )}
      {data && list.length === 0 && <EmptyState icon={ServerOff} title="Keine Server gefunden" description="Du benötigst die Berechtigung „Server verwalten“ oder einen freigeschalteten Dashboard-Zugriff." />}

      {withBot.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {withBot.map((g, i) => (
            <motion.div key={g.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
              <Link to={`/guild/${g.id}`} className="card group relative block overflow-hidden p-5 transition hover:-translate-y-0.5 hover:border-brand-500/40 hover:shadow-glow">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-brand-500/10 to-transparent opacity-0 transition group-hover:opacity-100" />
                <div className="relative flex items-center gap-4">
                  <Avatar src={g.icon} name={g.name} size={56} className="rounded-2xl" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{g.name}</div>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge color="brand">{ACCESS_LABEL[g.access]}</Badge>
                      {g.memberCount !== null && <span className="text-xs text-fg-subtle">{g.memberCount.toLocaleString('de-DE')} Mitglieder</span>}
                    </div>
                  </div>
                </div>
                <div className="relative mt-5 flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Bot aktiv
                  </span>
                  <span className="flex items-center gap-1 text-fg-muted transition group-hover:translate-x-0.5 group-hover:text-fg">
                    Verwalten <ArrowRight className="h-4 w-4" />
                  </span>
                </div>
              </Link>
            </motion.div>
          ))}
        </div>
      )}

      {withoutBot.length > 0 && (
        <>
          <h2 className="mt-12 mb-4 text-sm font-semibold tracking-wider text-fg-subtle uppercase">Bot noch nicht hinzugefügt</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {withoutBot.map((g) => (
              <div key={g.id} className="flex items-center gap-3 rounded-2xl border border-dashed border-line-strong bg-panel/40 p-4">
                <Avatar src={g.icon} name={g.name} size={40} className="rounded-xl opacity-70" />
                <div className="min-w-0 flex-1 truncate text-sm">{g.name}</div>
                {g.inviteUrl && (g.access === 'OWNER' || g.access === 'ADMIN') && (
                  <a href={g.inviteUrl} target="_blank" rel="noreferrer">
                    <Button size="sm" variant="primary" icon={Plus}>
                      Einladen
                    </Button>
                  </a>
                )}
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-fg-subtle">Nach dem Einladen auf „Neu laden“ klicken.</p>
        </>
      )}
    </div>
  );
}
