import type { ModuleConfigs, ModuleKey } from '@shared/modules';
export type { ModuleConfigs, ModuleKey };

export type AccessName = 'NONE' | 'VIEWER' | 'MODERATOR' | 'ADMIN' | 'OWNER';
export const ACCESS_RANK: Record<AccessName, number> = { NONE: 0, VIEWER: 1, MODERATOR: 2, ADMIN: 3, OWNER: 4 };

export interface Me {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  avatarUrl: string;
  botOwner: boolean;
}

export interface GuildListItem {
  id: string;
  name: string;
  icon: string | null;
  botPresent: boolean;
  memberCount: number | null;
  access: AccessName;
  inviteUrl: string | null;
}

export interface GuildLive {
  id: string;
  name: string;
  icon: string | null;
  banner: string | null;
  description: string | null;
  ownerId: string;
  memberCount: number;
  online: number;
  createdAt: string;
  boosts: number;
  boostTier: number;
  verificationLevel: number;
  explicitContentFilter: number;
  defaultMessageNotifications: number;
  systemChannelId: string | null;
  afkChannelId: string | null;
  afkTimeout: number;
  preferredLocale: string;
  channelCount: number;
  roleCount: number;
  emojiCount: number;
  cachedMembers: number;
  botPermissions: string;
  botMissing: string[];
  botHighestRole: number;
}

export interface GuildDetail {
  id: string;
  name: string;
  icon: string | null;
  memberCount: number;
  access: AccessName;
  modules: Record<ModuleKey, boolean>;
  live: GuildLive | null;
}

export interface Channel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  position: number;
  topic: string | null;
  nsfw: boolean;
  userLimit: number | null;
  botCanSend: boolean;
  overwrites: { id: string; type: 'role' | 'member'; allow: string; deny: string }[];
}

export interface Role {
  id: string;
  name: string;
  color: string;
  position: number;
  permissions: string;
  hoist: boolean;
  mentionable: boolean;
  managed: boolean;
  everyone: boolean;
  memberCount: number;
  editable: boolean;
  icon: string | null;
}

export interface BotStatus {
  online: boolean;
  ping?: number;
  guilds?: number;
  users?: number;
  uptimeMs?: number;
  startedAt?: number;
  tag?: string | null;
  avatar?: string | null;
  memoryMb?: number;
  updatedAt?: number;
}

export interface LogEntry {
  id: string;
  guildId?: string;
  category: string;
  type: string;
  actorId: string | null;
  targetId: string | null;
  channelId: string | null;
  summary: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface ModCase {
  id: number;
  caseNumber: number;
  type: 'WARN' | 'TIMEOUT' | 'UNTIMEOUT' | 'KICK' | 'BAN' | 'UNBAN' | 'NOTE';
  userId: string;
  userTag: string | null;
  moderatorId: string;
  reason: string | null;
  durationSec: number | null;
  expiresAt: string | null;
  active: boolean;
  source: 'COMMAND' | 'DASHBOARD' | 'AUTOMOD' | 'SYSTEM';
  createdAt: string;
}

export interface Ticket {
  id: number;
  number: number;
  channelId: string | null;
  ownerId: string;
  ownerTag: string | null;
  categoryKey: string;
  subject: string | null;
  status: 'OPEN' | 'CLAIMED' | 'CLOSED';
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  assigneeId: string | null;
  closedById: string | null;
  closeReason: string | null;
  createdAt: string;
  claimedAt: string | null;
  closedAt: string | null;
  _count?: { messages: number };
}

export interface TicketMessage {
  id: number | string;
  authorId: string;
  authorTag: string;
  authorBot: boolean;
  content: string;
  createdAt: string;
  attachments: { name: string; url: string }[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export const CHANNEL_TYPE = { TEXT: 0, VOICE: 2, CATEGORY: 4, ANNOUNCEMENT: 5, STAGE: 13, FORUM: 15 } as const;
