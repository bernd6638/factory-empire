import {
  Activity,
  Coins,
  Gift,
  LayoutDashboard,
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
  type LucideIcon,
} from 'lucide-react';
import type { AccessName, ModuleKey } from '../../lib/types';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  min: AccessName;
  module?: ModuleKey;
  /** Zusätzliche Suchbegriffe für die globale Suche */
  keywords?: string;
}

export interface NavGroup {
  id: string;
  title: string;
  items: NavItem[];
}

/** Zentrale Navigation – enthält nur Bereiche, die vollständig umgesetzt sind. */
export const NAV: NavGroup[] = [
  {
    id: 'overview',
    title: 'Overview',
    items: [
      { to: '', label: 'Control Center', icon: LayoutDashboard, min: 'VIEWER', keywords: 'start übersicht status warnungen' },
      { to: 'analytics', label: 'Live Analytics', icon: Activity, min: 'VIEWER', keywords: 'statistik diagramme wachstum dashboard' },
    ],
  },
  {
    id: 'server',
    title: 'Server Management',
    items: [
      { to: 'server', label: 'Server Control', icon: Server, min: 'VIEWER', keywords: 'kanäle rollen berechtigungen einstellungen' },
      { to: 'members', label: 'Mitglieder', icon: Users, min: 'VIEWER', keywords: 'nutzer profile inaktiv' },
      { to: 'moderation', label: 'Moderation', icon: ShieldAlert, min: 'MODERATOR', module: 'moderation', keywords: 'automod bann kick warn raid fälle' },
      { to: 'logs', label: 'Logs', icon: ScrollText, min: 'MODERATOR', module: 'logging', keywords: 'protokoll verlauf' },
    ],
  },
  {
    id: 'community',
    title: 'Community',
    items: [
      { to: 'giveaways', label: 'Giveaways', icon: Gift, min: 'MODERATOR', module: 'giveaways', keywords: 'gewinnspiel verlosung' },
      { to: 'leveling', label: 'Level & XP', icon: TrendingUp, min: 'VIEWER', module: 'leveling', keywords: 'rangliste xp belohnungen' },
      { to: 'economy', label: 'Economy', icon: Coins, min: 'VIEWER', module: 'economy', keywords: 'shop geld jobs firmen' },
    ],
  },
  {
    id: 'engage',
    title: 'Engagement & Automation',
    items: [
      { to: 'messages', label: 'Nachrichten', icon: Send, min: 'MODERATOR', keywords: 'embed senden ankündigung say' },
      { to: 'tickets', label: 'Tickets', icon: Ticket, min: 'MODERATOR', module: 'tickets', keywords: 'support anfragen' },
      { to: 'automations', label: 'Automation Builder', icon: Workflow, min: 'VIEWER', module: 'automation', keywords: 'regeln zeitplan willkommen erinnerungen umfrage' },
      { to: 'voice', label: 'Voice-Manager', icon: Mic, min: 'VIEWER', module: 'voice', keywords: 'sprachkanäle temporär' },
    ],
  },
  {
    id: 'system',
    title: 'System',
    items: [
      { to: 'plugins', label: 'Installed Modules', icon: Puzzle, min: 'VIEWER', keywords: 'plugins module aktivieren' },
      { to: 'settings', label: 'Einstellungen', icon: Settings, min: 'ADMIN', keywords: 'berechtigungen audit zugriff' },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV.flatMap((g) => g.items);
