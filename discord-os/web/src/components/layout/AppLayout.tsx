import { AnimatePresence, motion } from 'framer-motion';
import {
  Bot,
  ChevronsUpDown,
  Coins,
  Gauge,
  LogOut,
  Menu,
  Mic,
  Puzzle,
  ScrollText,
  Send,
  Server,
  Settings,
  ShieldAlert,
  Ticket,
  TrendingUp,
  Users,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useLiveContext } from '../../lib/live';
import { cn } from '../../lib/format';
import { ACCESS_RANK, type AccessName, type GuildListItem, type ModuleKey } from '../../lib/types';
import { useGuild, useGuildId } from '../../hooks/guild';
import { useMe } from './AuthGate';
import { Avatar, Badge, ErrorState, LoadingBlock } from '../ui/core';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  min: AccessName;
  module?: ModuleKey;
}

const NAV: { title: string; items: NavItem[] }[] = [
  {
    title: 'Übersicht',
    items: [
      { to: '', label: 'Dashboard', icon: Gauge, min: 'VIEWER' },
      { to: 'server', label: 'Server', icon: Server, min: 'VIEWER' },
    ],
  },
  {
    title: 'Community',
    items: [
      { to: 'members', label: 'Mitglieder', icon: Users, min: 'VIEWER' },
      { to: 'leveling', label: 'Level & XP', icon: TrendingUp, min: 'VIEWER', module: 'leveling' },
      { to: 'economy', label: 'Economy', icon: Coins, min: 'VIEWER', module: 'economy' },
    ],
  },
  {
    title: 'Sicherheit',
    items: [
      { to: 'moderation', label: 'Moderation', icon: ShieldAlert, min: 'MODERATOR', module: 'moderation' },
      { to: 'logs', label: 'Logs', icon: ScrollText, min: 'MODERATOR', module: 'logging' },
    ],
  },
  {
    title: 'Werkzeuge',
    items: [
      { to: 'messages', label: 'Nachrichten', icon: Send, min: 'MODERATOR' },
      { to: 'tickets', label: 'Tickets', icon: Ticket, min: 'MODERATOR', module: 'tickets' },
      { to: 'automations', label: 'Automatisierungen', icon: Workflow, min: 'VIEWER', module: 'automation' },
      { to: 'voice', label: 'Voice-Manager', icon: Mic, min: 'VIEWER', module: 'voice' },
    ],
  },
  {
    title: 'System',
    items: [
      { to: 'plugins', label: 'Plugins', icon: Puzzle, min: 'VIEWER' },
      { to: 'settings', label: 'Einstellungen', icon: Settings, min: 'ADMIN' },
    ],
  },
];

function Logo() {
  return (
    <Link to="/servers" className="flex items-center gap-3">
      <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 shadow-glow">
        <span className="text-sm font-bold text-white">OS</span>
      </div>
      <div className="leading-tight">
        <div className="font-semibold tracking-tight">Discord OS</div>
        <div className="text-[11px] text-fg-subtle">Server-Management</div>
      </div>
    </Link>
  );
}

function GuildSwitcher() {
  const guildId = useGuildId();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { data: guild } = useGuild();
  const { data: guilds } = useQuery({ queryKey: ['guilds'], queryFn: () => api.get<GuildListItem[]>('/guilds'), staleTime: 60_000, enabled: open });
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 rounded-xl border border-line bg-panel-2/70 p-2.5 text-left transition hover:border-line-strong">
        <Avatar src={guild?.icon} name={guild?.name} size={34} className="rounded-xl" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{guild?.name ?? 'Lädt …'}</div>
          <div className="text-[11px] text-fg-subtle">{guild ? `${guild.memberCount.toLocaleString('de-DE')} Mitglieder` : ' '}</div>
        </div>
        <ChevronsUpDown className="h-4 w-4 text-fg-subtle" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="absolute z-50 mt-2 max-h-80 w-full overflow-y-auto rounded-xl border border-line-strong bg-panel-2 p-1 shadow-2xl">
            {(guilds ?? [])
              .filter((g) => g.botPresent)
              .map((g) => (
                <button
                  key={g.id}
                  onClick={() => {
                    setOpen(false);
                    navigate(`/guild/${g.id}`);
                  }}
                  className={cn('flex w-full items-center gap-2.5 rounded-lg p-2 text-left text-sm hover:bg-panel-3', g.id === guildId && 'bg-brand-500/10')}
                >
                  <Avatar src={g.icon} name={g.name} size={26} className="rounded-lg" />
                  <span className="truncate">{g.name}</span>
                </button>
              ))}
            <Link to="/servers" onClick={() => setOpen(false)} className="mt-1 block rounded-lg border-t border-line p-2 text-center text-xs text-fg-muted hover:text-fg">
              Alle Server anzeigen
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const guildId = useGuildId();
  const { data: guild } = useGuild();
  const rank = guild ? ACCESS_RANK[guild.access] : 0;
  return (
    <div className="flex h-full flex-col gap-5 p-4">
      <div className="px-1 pt-1">
        <Logo />
      </div>
      <GuildSwitcher />
      <nav className="-mx-1 flex-1 space-y-5 overflow-y-auto px-1">
        {NAV.map((group) => {
          const items = group.items.filter((i) => rank >= ACCESS_RANK[i.min]);
          if (!items.length) return null;
          return (
            <div key={group.title}>
              <div className="mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-fg-subtle uppercase">{group.title}</div>
              <div className="space-y-0.5">
                {items.map((item) => {
                  const off = item.module && guild && !guild.modules[item.module];
                  return (
                    <NavLink
                      key={item.to}
                      to={`/guild/${guildId}${item.to ? `/${item.to}` : ''}`}
                      end={item.to === ''}
                      onClick={onNavigate}
                      className={({ isActive }) =>
                        cn('group relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors', isActive ? 'text-fg' : 'text-fg-muted hover:bg-panel-2 hover:text-fg')
                      }
                    >
                      {({ isActive }) => (
                        <>
                          {isActive && <motion.span layoutId="nav-active" className="absolute inset-0 rounded-xl bg-gradient-to-r from-brand-500/20 to-accent-500/5 ring-1 ring-brand-500/30" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                          <item.icon className={cn('relative h-[18px] w-[18px]', isActive ? 'text-brand-300' : 'text-fg-subtle group-hover:text-fg-muted')} />
                          <span className="relative flex-1">{item.label}</span>
                          {off && <span className="relative h-1.5 w-1.5 rounded-full bg-fg-subtle" title="Modul deaktiviert" />}
                        </>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
      <UserCard />
    </div>
  );
}

function UserCard() {
  const { data: me } = useMe();
  const { data: guild } = useGuild();
  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    location.href = '/login';
  };
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-panel-2/60 p-2.5">
      <Avatar src={me?.avatarUrl} name={me?.username} size={34} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{me?.globalName ?? me?.username}</div>
        {guild && <div className="text-[11px] text-fg-subtle">{{ OWNER: 'Besitzer', ADMIN: 'Administrator', MODERATOR: 'Moderator', VIEWER: 'Betrachter', NONE: '' }[guild.access]}</div>}
      </div>
      <button onClick={logout} title="Abmelden" className="rounded-lg p-2 text-fg-subtle transition hover:bg-panel-3 hover:text-red-300">
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  );
}

export function BotStatusPill() {
  const { bot, connected } = useLiveContext();
  const online = !!bot?.online;
  return (
    <div className="flex items-center gap-2">
      <Badge color={connected ? 'green' : 'yellow'} dot>
        {connected ? 'Live' : 'Verbinde …'}
      </Badge>
      <Badge color={online ? 'brand' : 'red'}>
        <Bot className="h-3 w-3" />
        {online ? `Bot online · ${bot?.ping ?? 0} ms` : 'Bot offline'}
      </Badge>
    </div>
  );
}

/** Rahmen für alle Server-Seiten: Sidebar, Kopfzeile, Live-Abo. */
export function GuildLayout() {
  const guildId = useGuildId();
  const { subscribe } = useLiveContext();
  const { data: guild, error, isLoading, refetch } = useGuild();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    subscribe(guildId);
    return () => subscribe(null);
  }, [guildId, subscribe]);
  useEffect(() => setMobileOpen(false), [location.pathname]);

  return (
    <div className="min-h-screen lg:pl-72">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 border-r border-line bg-panel lg:block">
        <Sidebar />
      </aside>
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div className="fixed inset-0 z-40 bg-black/60 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMobileOpen(false)} />
            <motion.aside className="fixed inset-y-0 left-0 z-50 w-72 border-r border-line bg-panel lg:hidden" initial={{ x: -300 }} animate={{ x: 0 }} exit={{ x: -300 }} transition={{ type: 'spring', stiffness: 400, damping: 38 }}>
              <button className="absolute top-4 right-3 rounded-lg p-2 text-fg-muted" onClick={() => setMobileOpen(false)}>
                <X className="h-5 w-5" />
              </button>
              <Sidebar onNavigate={() => setMobileOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-3 border-b border-line/70 bg-base/95 px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <button className="rounded-lg p-2 text-fg-muted hover:bg-panel-2 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Menü">
            <Menu className="h-5 w-5" />
          </button>
          <span className="truncate text-sm text-fg-muted lg:hidden">{guild?.name}</span>
        </div>
        <BotStatusPill />
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {isLoading ? <LoadingBlock /> : error ? <ErrorState error={error} onRetry={() => refetch()} /> : <Outlet />}
      </main>
    </div>
  );
}

export function PlainLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen">{children}</div>;
}
