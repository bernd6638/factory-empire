import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type PermissionResolvable,
} from 'discord.js';
import { RpcError } from '../../shared/bus';

/** Holt einen Textkanal und prüft, ob der Bot dort senden darf. */
export async function getSendableChannel(guild: Guild, channelId: string | null | undefined): Promise<GuildTextBasedChannel | null> {
  if (!channelId) return null;
  const ch = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!ch || !ch.isTextBased() || ch.isDMBased()) return null;
  const me = guild.members.me;
  if (!me) return null;
  const perms = ch.permissionsFor(me);
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return null;
  return ch as GuildTextBasedChannel;
}

/** Wirft einen verständlichen Fehler, wenn dem Bot eine Berechtigung fehlt. */
export function requireBotPermission(guild: Guild, perm: PermissionResolvable, label: string) {
  const me = guild.members.me;
  if (!me || !me.permissions.has(perm)) {
    throw new RpcError('MISSING_PERMISSIONS', `Dem Bot fehlt die Berechtigung „${label}“.`);
  }
}

/** Prüft die Rollenhierarchie: kann der Bot dieses Mitglied moderieren? */
export function botCanModerate(target: GuildMember): boolean {
  const me = target.guild.members.me;
  if (!me) return false;
  if (target.id === target.guild.ownerId) return false;
  if (target.id === me.id) return false;
  return me.roles.highest.comparePositionTo(target.roles.highest) > 0;
}

/** Kann `actor` das Mitglied `target` moderieren (Hierarchie)? */
export function actorCanModerate(actor: GuildMember, target: GuildMember): boolean {
  if (actor.id === actor.guild.ownerId) return target.id !== actor.id;
  if (target.id === target.guild.ownerId) return false;
  return actor.roles.highest.comparePositionTo(target.roles.highest) > 0;
}

/** Kann der Bot diese Rolle vergeben/entfernen? */
export function botCanManageRole(guild: Guild, roleId: string): boolean {
  const me = guild.members.me;
  const role = guild.roles.cache.get(roleId);
  if (!me || !role || role.managed || role.id === guild.id) return false;
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
  return me.roles.highest.comparePositionTo(role) > 0;
}

export function isTextChannelType(type: ChannelType) {
  return [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(type);
}

export function avatarUrl(userId: string, avatar: string | null): string {
  if (avatar) return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.${avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`;
  const idx = Number((BigInt(userId) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

export function userSnapshot(u: { id: string; username: string; avatar: string | null; bot: boolean; globalName?: string | null }) {
  return { id: u.id, username: u.globalName ? `${u.globalName}` : u.username, avatar: u.avatar, bot: u.bot };
}
