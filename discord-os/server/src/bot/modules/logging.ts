import { ChannelType, PermissionsBitField, type GuildBasedChannel } from 'discord.js';
import { prisma } from '../../shared/prisma';
import { MODULES } from '../../shared/modules';
import type { BotModule } from '../core/types';
import { COLORS, truncate } from '../utils/embeds';

const CHANNEL_TYPES: Partial<Record<ChannelType, string>> = {
  [ChannelType.GuildText]: 'Textkanal',
  [ChannelType.GuildVoice]: 'Sprachkanal',
  [ChannelType.GuildCategory]: 'Kategorie',
  [ChannelType.GuildAnnouncement]: 'Ankündigungskanal',
  [ChannelType.GuildStageVoice]: 'Stage',
  [ChannelType.GuildForum]: 'Forum',
};

function channelLabel(c: GuildBasedChannel | { name: string; type: ChannelType }) {
  return `${CHANNEL_TYPES[c.type] ?? 'Kanal'} „${c.name}“`;
}

export const loggingModule: BotModule = {
  id: 'logging',
  events: {
    async messageDelete(ctx, message) {
      if (!message.inGuild()) return;
      const { config } = await ctx.config.get(message.guildId, 'logging');
      if (message.author?.bot && config.ignoreBots) return;
      const content = message.partial ? null : message.content;
      await ctx.logs.write({
        guildId: message.guildId,
        category: 'messages',
        type: 'message_delete',
        toggle: 'messageDelete',
        summary: message.partial
          ? `Eine nicht zwischengespeicherte Nachricht in <#${message.channelId}> wurde gelöscht.`
          : `Nachricht von ${message.author.username} in <#${message.channelId}> gelöscht: ${truncate(content || '[kein Text]', 300)}`,
        targetId: message.author?.id ?? null,
        channelId: message.channelId,
        data: { content, attachments: message.attachments?.map((a) => a.url) ?? [], messageId: message.id },
        color: COLORS.danger,
        fields: content ? [{ name: 'Inhalt', value: truncate(content, 1000) }] : [],
      });
    },
    async messageDeleteBulk(ctx, messages, channel) {
      if (channel.isDMBased()) return;
      await ctx.logs.write({
        guildId: channel.guildId,
        category: 'messages',
        type: 'message_bulk_delete',
        toggle: 'messageDelete',
        summary: `${messages.size} Nachrichten in <#${channel.id}> wurden gesammelt gelöscht.`,
        channelId: channel.id,
        data: { count: messages.size },
        color: COLORS.danger,
      });
    },
    async messageUpdate(ctx, oldMessage, newMessage) {
      if (!newMessage.inGuild()) return;
      if (oldMessage.partial || oldMessage.content === newMessage.content) return;
      const { config } = await ctx.config.get(newMessage.guildId, 'logging');
      if (newMessage.author.bot && config.ignoreBots) return;
      await ctx.logs.write({
        guildId: newMessage.guildId,
        category: 'messages',
        type: 'message_update',
        toggle: 'messageUpdate',
        summary: `${newMessage.author.username} hat eine Nachricht in <#${newMessage.channelId}> bearbeitet.`,
        targetId: newMessage.author.id,
        channelId: newMessage.channelId,
        data: { before: oldMessage.content, after: newMessage.content, url: newMessage.url },
        color: COLORS.info,
        fields: [
          { name: 'Vorher', value: truncate(oldMessage.content || '—', 1000) },
          { name: 'Nachher', value: truncate(newMessage.content || '—', 1000) },
        ],
      });
    },
    async guildMemberAdd(ctx, member) {
      const ageDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86_400_000);
      await ctx.logs.write({
        guildId: member.guild.id,
        category: 'members',
        type: 'member_join',
        toggle: 'memberJoin',
        summary: `${member.user.username} ist beigetreten (Konto ${ageDays} Tage alt). Mitglieder: ${member.guild.memberCount}`,
        targetId: member.id,
        data: { accountAgeDays: ageDays, bot: member.user.bot },
        color: COLORS.success,
      });
    },
    async guildMemberRemove(ctx, member) {
      await ctx.logs.write({
        guildId: member.guild.id,
        category: 'members',
        type: 'member_leave',
        toggle: 'memberLeave',
        summary: `${member.user?.username ?? member.id} hat den Server verlassen. Mitglieder: ${member.guild.memberCount}`,
        targetId: member.id,
        data: { roles: member.roles?.cache.map((r) => r.name).filter((n) => n !== '@everyone') ?? [] },
        color: COLORS.warning,
      });
    },
    async guildMemberUpdate(ctx, oldMember, newMember) {
      if (oldMember.partial) return;
      const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
      const removed = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id));
      if (added.size || removed.size) {
        const parts = [added.size ? `+ ${added.map((r) => r.name).join(', ')}` : '', removed.size ? `− ${removed.map((r) => r.name).join(', ')}` : ''].filter(Boolean);
        await ctx.logs.write({
          guildId: newMember.guild.id,
          category: 'members',
          type: 'member_roles',
          toggle: 'memberUpdate',
          summary: `Rollen von ${newMember.user.username} geändert: ${parts.join(' / ')}`,
          targetId: newMember.id,
          data: { added: added.map((r) => ({ id: r.id, name: r.name })), removed: removed.map((r) => ({ id: r.id, name: r.name })) },
          color: COLORS.violet,
        });
      }
      if (oldMember.nickname !== newMember.nickname) {
        await ctx.logs.write({
          guildId: newMember.guild.id,
          category: 'members',
          type: 'member_nickname',
          toggle: 'memberUpdate',
          summary: `${newMember.user.username}: Nickname „${oldMember.nickname ?? '—'}“ → „${newMember.nickname ?? '—'}“`,
          targetId: newMember.id,
          data: { before: oldMember.nickname, after: newMember.nickname },
          color: COLORS.info,
        });
      }
    },
    async roleCreate(ctx, role) {
      await ctx.logs.write({ guildId: role.guild.id, category: 'roles', type: 'role_create', toggle: 'roleChanges', summary: `Rolle „${role.name}“ wurde erstellt.`, targetId: role.id, data: { color: role.hexColor }, color: COLORS.success });
    },
    async roleDelete(ctx, role) {
      await ctx.logs.write({ guildId: role.guild.id, category: 'roles', type: 'role_delete', toggle: 'roleChanges', summary: `Rolle „${role.name}“ wurde gelöscht.`, targetId: role.id, data: {}, color: COLORS.danger });
    },
    async roleUpdate(ctx, oldRole, newRole) {
      const changes: string[] = [];
      if (oldRole.name !== newRole.name) changes.push(`Name: „${oldRole.name}“ → „${newRole.name}“`);
      if (oldRole.hexColor !== newRole.hexColor) changes.push(`Farbe: ${oldRole.hexColor} → ${newRole.hexColor}`);
      if (oldRole.hoist !== newRole.hoist) changes.push(`Getrennt anzeigen: ${newRole.hoist ? 'ja' : 'nein'}`);
      if (oldRole.mentionable !== newRole.mentionable) changes.push(`Erwähnbar: ${newRole.mentionable ? 'ja' : 'nein'}`);
      if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
        const added = new PermissionsBitField(newRole.permissions.bitfield & ~oldRole.permissions.bitfield).toArray();
        const removed = new PermissionsBitField(oldRole.permissions.bitfield & ~newRole.permissions.bitfield).toArray();
        if (added.length) changes.push(`+ Rechte: ${added.join(', ')}`);
        if (removed.length) changes.push(`− Rechte: ${removed.join(', ')}`);
      }
      if (!changes.length) return;
      await ctx.logs.write({
        guildId: newRole.guild.id,
        category: 'roles',
        type: 'role_update',
        toggle: 'roleChanges',
        summary: `Rolle „${newRole.name}“ geändert: ${changes.join('; ')}`,
        targetId: newRole.id,
        data: { changes },
        color: COLORS.info,
      });
    },
    async channelCreate(ctx, channel) {
      await ctx.logs.write({ guildId: channel.guildId, category: 'channels', type: 'channel_create', toggle: 'channelChanges', summary: `${channelLabel(channel)} wurde erstellt.`, channelId: channel.id, data: { type: channel.type }, color: COLORS.success });
    },
    async channelDelete(ctx, channel) {
      if (channel.isDMBased()) return;
      await ctx.logs.write({ guildId: channel.guildId, category: 'channels', type: 'channel_delete', toggle: 'channelChanges', summary: `${channelLabel(channel)} wurde gelöscht.`, channelId: channel.id, data: { type: channel.type }, color: COLORS.danger });
    },
    async channelUpdate(ctx, oldChannel, newChannel) {
      if (oldChannel.isDMBased() || newChannel.isDMBased()) return;
      const changes: string[] = [];
      if (oldChannel.name !== newChannel.name) changes.push(`Name: „${oldChannel.name}“ → „${newChannel.name}“`);
      if ('topic' in oldChannel && 'topic' in newChannel && oldChannel.topic !== newChannel.topic) changes.push('Thema geändert');
      if (oldChannel.parentId !== newChannel.parentId) changes.push('Kategorie geändert');
      if ('nsfw' in oldChannel && 'nsfw' in newChannel && oldChannel.nsfw !== newChannel.nsfw) changes.push(`NSFW: ${newChannel.nsfw ? 'an' : 'aus'}`);
      if ('rateLimitPerUser' in oldChannel && 'rateLimitPerUser' in newChannel && oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) changes.push(`Slowmode: ${newChannel.rateLimitPerUser}s`);
      if ('permissionOverwrites' in oldChannel && 'permissionOverwrites' in newChannel) {
        const a = oldChannel.permissionOverwrites.cache;
        const b = newChannel.permissionOverwrites.cache;
        const changed = a.size !== b.size || [...b.values()].some((o) => {
          const prev = a.get(o.id);
          return !prev || prev.allow.bitfield !== o.allow.bitfield || prev.deny.bitfield !== o.deny.bitfield;
        });
        if (changed) changes.push('Berechtigungen geändert');
      }
      if (!changes.length) return;
      await ctx.logs.write({
        guildId: newChannel.guildId,
        category: 'channels',
        type: 'channel_update',
        toggle: 'channelChanges',
        summary: `${channelLabel(newChannel)} geändert: ${changes.join('; ')}`,
        channelId: newChannel.id,
        data: { changes },
        color: COLORS.info,
      });
    },
    async voiceStateUpdate(ctx, oldState, newState) {
      if (oldState.channelId === newState.channelId) return;
      const member = newState.member ?? oldState.member;
      if (!member || member.user.bot) return;
      const guildId = newState.guild.id;
      let type: string;
      let summary: string;
      if (!oldState.channelId) {
        type = 'voice_join';
        summary = `${member.user.username} ist <#${newState.channelId}> beigetreten.`;
      } else if (!newState.channelId) {
        type = 'voice_leave';
        summary = `${member.user.username} hat <#${oldState.channelId}> verlassen.`;
      } else {
        type = 'voice_move';
        summary = `${member.user.username} wechselte von <#${oldState.channelId}> zu <#${newState.channelId}>.`;
      }
      ctx.live(guildId, 'voice.state', { type, userId: member.id, from: oldState.channelId, to: newState.channelId });
      await ctx.logs.write({ guildId, category: 'voice', type, toggle: 'voice', summary, targetId: member.id, channelId: newState.channelId ?? oldState.channelId, data: { from: oldState.channelId, to: newState.channelId }, color: COLORS.muted });
    },
    async guildUpdate(ctx, oldGuild, newGuild) {
      const changes: string[] = [];
      if (oldGuild.name !== newGuild.name) changes.push(`Name: „${oldGuild.name}“ → „${newGuild.name}“`);
      if (oldGuild.icon !== newGuild.icon) changes.push('Icon geändert');
      if (oldGuild.verificationLevel !== newGuild.verificationLevel) changes.push(`Verifizierungsstufe: ${newGuild.verificationLevel}`);
      if (oldGuild.ownerId !== newGuild.ownerId) changes.push(`Neuer Besitzer: <@${newGuild.ownerId}>`);
      if (!changes.length) return;
      await ctx.logs.write({ guildId: newGuild.id, category: 'server', type: 'server_update', summary: `Server geändert: ${changes.join('; ')}`, data: { changes }, color: COLORS.info });
    },
  },
  jobs: [
    {
      name: 'retention',
      intervalMs: 6 * 3_600_000,
      initialDelayMs: 5 * 60_000,
      async run() {
        // Aufbewahrungsdauer pro Server anwenden
        const rows = await prisma.guildModule.findMany({ where: { moduleKey: 'logging' }, select: { guildId: true, config: true } });
        const fallback = MODULES.logging.schema.parse({}).retentionDays;
        for (const row of rows) {
          const days = Number((row.config as { retentionDays?: number })?.retentionDays) || fallback;
          await prisma.logEntry.deleteMany({ where: { guildId: row.guildId, createdAt: { lt: new Date(Date.now() - days * 86_400_000) } } });
        }
        // Stündliche Statistik nach einem Jahr entfernen
        await prisma.guildStatHour.deleteMany({ where: { hour: { lt: new Date(Date.now() - 365 * 86_400_000) } } });
      },
    },
  ],
};
