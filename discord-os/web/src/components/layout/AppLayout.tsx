import { AnimatePresence, motion } from 'framer-motion';
import { Bot, Gauge, ChevronDown, ChevronsLeft, ChevronsRight, ChevronsUpDown, LayoutGrid, LogOut, Menu, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useLiveContext } from '../../lib/live';
import { setReduceEffects, useReduceEffects } from '../../lib/perf';
import { cn } from '../../lib/format';
import { ACCESS_RANK, type GuildListItem } from '../../lib/types';
import { useGuild, useGuildId } from '../../hooks/guild';
import { useMe } from './AuthGate';
import { Avatar, ErrorState, LoadingBlock } from '../ui/core';
import { ALL_NAV_ITEMS, NAV } from './nav';
import { Logo } from './Logo';
import { NotificationBell, NotificationProvider } from './notifications';
import { QuickActionsMenu, QuickActionsProvider, useQuickActions } from './commands';

const ACCESS_LABEL = { OWNER: 'Besitzer', ADMIN: 'Administrator', MODERATOR: 'Moderator', VIEWER: 'Betrachter', NONE: '' } as const;

function usePersistent<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* ignorieren */
    }
  };
  return [v, set];
}

function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onOutside();
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onOutside]);
  return ref;
}

function GuildSwitcher({ compact }: { compact?: boolean }) {
  const guildId = useGuildId();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { data: guild } = useGuild();
  const { data: guilds } = useQuery({ queryKey: ['guilds'], queryFn: () => api.get<GuildListItem[]>('/guilds'), staleTime: 60_000, enabled: open });
  const ref = useClickOutside(() => setOpen(false));
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn('flex w-full items-center gap-3 rounded-xl border border-line bg-white/[0.02] text-left transition hover:border-line-strong hover:bg-white/[0.04]', compact ? 'justify-center p-1.5' : 'p-2.5')}
        title={guild?.name}
      >
        <Avatar src={guild?.icon} name={guild?.name} size={compact ? 32 : 34} className="rounded-xl" />
        {!compact && (
          <>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{guild?.name ?? 'Lädt …'}</div>
              <div className="text-[11px] text-fg-subtle">{guild ? `${guild.memberCount.toLocaleString('de-DE')} Mitglieder` : ' '}</div>
            </div>
            <ChevronsUpDown className="h-4 w-4 text-fg-subtle" />
          </>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.14 }} className="card absolute z-50 mt-2 max-h-80 w-64 overflow-y-auto bg-panel p-1.5 shadow-2xl">
            <div className="px-2.5 pt-1.5 pb-2 text-[10px] font-semibold tracking-[0.12em] text-fg-subtle uppercase">Server wechseln</div>
            {(guilds ?? [])
              .filter((g) => g.botPresent)
              .map((g) => (
                <button
                  key={g.id}
                  onClick={() => {
                    setOpen(false);
                    navigate(`/guild/${g.id}`);
                  }}
                  className={cn('flex w-full items-center gap-2.5 rounded-lg p-2 text-left text-sm transition hover:bg-white/[0.04]', g.id === guildId && 'bg-brand-500/10 ring-1 ring-brand-500/25')}
                >
                  <Avatar src={g.icon} name={g.name} size={26} className="rounded-lg" />
                  <span className="flex-1 truncate">{g.name}</span>
                  <span className="text-[10px] text-fg-subtle">{ACCESS_LABEL[g.access]}</span>
                </button>
              ))}
            <Link to="/servers" onClick={() => setOpen(false)} className="mt-1 flex items-center justify-center gap-2 rounded-lg border-t border-line p-2 text-xs text-fg-muted hover:text-fg">
              <LayoutGrid className="h-3.5 w-3.5" /> Alle Server
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Sidebar({ collapsed, onToggle, onNavigate, mobile }: { collapsed: boolean; onToggle?: () => void; onNavigate?: () => void; mobile?: boolean }) {
  const guildId = useGuildId();
  const { data: guild } = useGuild();
  const { data: me } = useMe();
  const rank = guild ? ACCESS_RANK[guild.access] : 0;
  const [closed, setClosed] = usePersistent<string[]>('dos:navgroups', []);
  const toggleGroup = (id: string) => setClosed(closed.includes(id) ? closed.filter((x) => x !== id) : [...closed, id]);

  return (
    <div className="flex h-full flex-col">
      <div className={cn('flex items-center gap-2 px-4 pt-5 pb-4', collapsed && 'justify-center px-2')}>
        <Link to="/servers" className="min-w-0 flex-1">
          <Logo collapsed={collapsed} />
        </Link>
        {!mobile && onToggle && !collapsed && (
          <button onClick={onToggle} className="rounded-lg p-1.5 text-fg-subtle transition hover:bg-white/[0.05] hover:text-fg" title="Sidebar einklappen">
            <ChevronsLeft className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className={cn('px-4 pb-3', collapsed && 'px-2')}>
        <GuildSwitcher compact={collapsed} />
      </div>
      <nav className={cn('flex-1 space-y-1 overflow-y-auto px-3 pb-4', collapsed && 'px-2')}>
        {NAV.map((group) => {
          const items = group.items.filter((i) => rank >= ACCESS_RANK[i.min]);
          if (!items.length) return null;
          const isClosed = closed.includes(group.id) && !collapsed;
          return (
            <div key={group.id} className="pt-2">
              {!collapsed ? (
                <button onClick={() => toggleGroup(group.id)} className="group flex w-full items-center justify-between px-3 py-1.5 text-[10px] font-semibold tracking-[0.14em] text-fg-subtle uppercase transition hover:text-fg-muted">
                  {group.title}
                  <ChevronDown className={cn('h-3 w-3 transition-transform', isClosed && '-rotate-90')} />
                </button>
              ) : (
                <div className="mx-auto my-2 h-px w-6 bg-line" />
              )}
              <AnimatePresence initial={false}>
                {!isClosed && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="space-y-0.5 overflow-hidden">
                    {items.map((item) => {
                      const off = item.module && guild && !guild.modules[item.module];
                      return (
                        <NavLink
                          key={item.to}
                          to={`/guild/${guildId}${item.to ? `/${item.to}` : ''}`}
                          end={item.to === ''}
                          onClick={onNavigate}
                          title={collapsed ? item.label : undefined}
                          className={({ isActive }) =>
                            cn(
                              'group relative flex items-center gap-3 rounded-xl text-[13.5px] font-medium transition-colors',
                              collapsed ? 'justify-center p-2.5' : 'px-3 py-2',
                              isActive ? 'text-fg' : 'text-fg-muted hover:bg-white/[0.035] hover:text-fg',
                            )
                          }
                        >
                          {({ isActive }) => (
                            <>
                              {isActive && (
                                <motion.span layoutId="nav-active" className="absolute inset-0 rounded-xl bg-gradient-to-r from-brand-500/[0.22] via-brand-500/[0.08] to-transparent ring-1 ring-brand-500/30" transition={{ type: 'spring', stiffness: 500, damping: 40 }}>
                                  <span className="absolute top-1/2 -left-3 h-5 w-1 -translate-y-1/2 rounded-r-full bg-gradient-to-b from-brand-400 to-accent-500 shadow-[0_0_12px_#7d8dff]" />
                                </motion.span>
                              )}
                              <item.icon className={cn('relative h-[18px] w-[18px] shrink-0 transition-colors', isActive ? 'text-brand-300' : 'text-fg-subtle group-hover:text-fg-muted')} />
                              {!collapsed && <span className="relative flex-1 truncate">{item.label}</span>}
                              {!collapsed && off && <span className="relative rounded-md bg-white/5 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-fg-subtle uppercase">aus</span>}
                            </>
                          )}
                        </NavLink>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </nav>
      <div className={cn('border-t border-line/70 p-3', collapsed && 'px-2')}>
        {collapsed ? (
          <button onClick={onToggle} className="flex w-full justify-center rounded-lg p-2 text-fg-subtle hover:bg-white/[0.05] hover:text-fg" title="Sidebar ausklappen">
            <ChevronsRight className="h-4 w-4" />
          </button>
        ) : (
          <div className="flex items-center gap-3 rounded-xl p-1.5">
            <Avatar src={me?.avatarUrl} name={me?.username} size={34} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{me?.globalName ?? me?.username}</div>
              {guild && <div className="text-[11px] text-fg-subtle">{ACCESS_LABEL[guild.access]}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function BotStatusPill() {
  const { bot, connected } = useLiveContext();
  const online = !!bot?.online;
  return (
    <div className="hidden items-center gap-1 rounded-xl border border-line bg-white/[0.02] p-1 sm:flex">
      <span className={cn('flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium', connected ? 'text-emerald-300' : 'text-amber-300')} title="Echtzeitverbindung zum Dashboard">
        <span className={cn('h-1.5 w-1.5 rounded-full', connected ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' : 'animate-pulse-soft bg-amber-400')} />
        {connected ? 'Live' : 'Verbinde'}
      </span>
      <span className={cn('flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium', online ? 'bg-brand-500/10 text-brand-300' : 'bg-red-500/10 text-red-300')} title="Status des Discord-Bots">
        <Bot className="h-3 w-3" />
        {online ? `${bot?.ping ?? 0} ms` : 'Bot offline'}
      </span>
    </div>
  );
}

function ProfileMenu() {
  const { data: me } = useMe();
  const reduce = useReduceEffects();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    location.href = '/login';
  };
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} className="rounded-full ring-2 ring-transparent transition hover:ring-brand-500/40" aria-label="Profil">
        <Avatar src={me?.avatarUrl} name={me?.username} size={34} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.14 }} className="card absolute right-0 z-50 mt-2 w-60 bg-panel p-1.5 shadow-2xl">
            <div className="flex items-center gap-3 border-b border-line px-2.5 pt-1.5 pb-3">
              <Avatar src={me?.avatarUrl} name={me?.username} size={36} />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{me?.globalName ?? me?.username}</div>
                <div className="truncate text-xs text-fg-subtle">@{me?.username}</div>
              </div>
            </div>
            <button onClick={() => setReduceEffects(!reduce)} className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-fg-muted hover:bg-white/[0.04] hover:text-fg">
              <Gauge className="h-4 w-4" />
              <span className="flex-1 text-left">Effekte reduzieren</span>
              <span className={cn('relative h-5 w-9 rounded-full transition', reduce ? 'bg-brand-500' : 'bg-panel-3')}>
                <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', reduce ? 'left-[18px]' : 'left-0.5')} />
              </span>
            </button>
            <Link to="/servers" onClick={() => setOpen(false)} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-fg-muted hover:bg-white/[0.04] hover:text-fg">
              <LayoutGrid className="h-4 w-4" /> Serverauswahl
            </Link>
            <button onClick={logout} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-red-300 hover:bg-red-500/10">
              <LogOut className="h-4 w-4" /> Abmelden
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SearchButton() {
  const { openPalette } = useQuickActions();
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  return (
    <button onClick={openPalette} className="flex h-10 w-full max-w-md items-center gap-3 rounded-xl border border-line bg-white/[0.02] px-3.5 text-sm text-fg-subtle transition hover:border-line-strong hover:bg-white/[0.04] hover:text-fg-muted">
      <Search className="h-4 w-4" />
      <span className="flex-1 text-left">Suchen …</span>
      <span className="hidden items-center gap-1 sm:flex">
        <span className="kbd">{isMac ? '⌘' : 'Strg'}</span>
        <span className="kbd">K</span>
      </span>
    </button>
  );
}

/** Rahmen aller Server-Seiten: Sidebar, Topbar, Seitenübergänge, Live-Abo, Benachrichtigungen, Schnellaktionen. */
export function GuildLayout() {
  const guildId = useGuildId();
  const { subscribe } = useLiveContext();
  const { error, isLoading, refetch } = useGuild();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = usePersistent('dos:sidebar-collapsed', false);
  const location = useLocation();
  const current = ALL_NAV_ITEMS.find((i) => location.pathname === `/guild/${guildId}${i.to ? `/${i.to}` : ''}`);

  useEffect(() => {
    subscribe(guildId);
    return () => subscribe(null);
  }, [guildId, subscribe]);
  useEffect(() => setMobileOpen(false), [location.pathname]);

  return (
    <NotificationProvider>
      <QuickActionsProvider>
        <div className={cn('min-h-screen transition-[padding] duration-300', collapsed ? 'lg:pl-[76px]' : 'lg:pl-72')}>
          <aside className={cn('fixed inset-y-0 left-0 z-30 hidden border-r border-line/80 bg-panel/95 transition-[width] duration-300 lg:block', collapsed ? 'w-[76px]' : 'w-72')}>
            <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
          </aside>
          <AnimatePresence>
            {mobileOpen && (
              <>
                <motion.div className="fixed inset-0 z-40 bg-black/70 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMobileOpen(false)} />
                <motion.aside className="fixed inset-y-0 left-0 z-50 w-72 border-r border-line bg-panel lg:hidden" initial={{ x: -300 }} animate={{ x: 0 }} exit={{ x: -300 }} transition={{ type: 'spring', stiffness: 400, damping: 38 }}>
                  <button className="absolute top-5 right-3 z-10 rounded-lg p-2 text-fg-muted" onClick={() => setMobileOpen(false)} aria-label="Menü schließen">
                    <X className="h-5 w-5" />
                  </button>
                  <Sidebar collapsed={false} mobile onNavigate={() => setMobileOpen(false)} />
                </motion.aside>
              </>
            )}
          </AnimatePresence>

          <header className="glass sticky top-0 z-20 border-b border-line/70">
            <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
              <button className="rounded-lg p-2 text-fg-muted hover:bg-white/[0.05] lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Menü">
                <Menu className="h-5 w-5" />
              </button>
              <div className="hidden min-w-0 items-center gap-2 text-sm xl:flex">
                {current && <current.icon className="h-4 w-4 text-brand-300" />}
                <span className="truncate font-medium text-fg-muted">{current?.label}</span>
              </div>
              <div className="flex flex-1 justify-center xl:px-6">
                <SearchButton />
              </div>
              <div className="flex items-center gap-2">
                <BotStatusPill />
                <QuickActionsMenu />
                <NotificationBell />
                <ProfileMenu />
              </div>
            </div>
          </header>

          <main className="mx-auto max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            {isLoading ? (
              <LoadingBlock />
            ) : error ? (
              <ErrorState error={error} onRetry={() => refetch()} />
            ) : (
              <AnimatePresence mode="wait">
                <motion.div key={location.pathname} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
                  <Outlet />
                </motion.div>
              </AnimatePresence>
            )}
          </main>
        </div>
      </QuickActionsProvider>
    </NotificationProvider>
  );
}

export function PlainLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen">{children}</div>;
}
