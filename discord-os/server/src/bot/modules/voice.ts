import {
  ChannelType,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Guild,
  type GuildMember,
  type VoiceChannel,
} from 'discord.js';
import { z } from 'zod';
import { prisma } from '../../shared/prisma';
import { renderTemplate } from '../../shared/template';
import { RpcError } from '../../shared/bus';
import { childLogger } from '../../shared/logger';
import { snowflake } from '../../shared/modules';
import type { BotContext, BotModule } from '../core/types';
import { failure, success } from '../utils/embeds';
import { getGuild, parse } from './core';

const log = childLogger('voice');
const pendingDeletes = new Map<string, NodeJS.Timeout>();
/** Schutz gegen doppelte Erstellung, wenn jemand mehrfach schnell beitritt */
const creating = new Set<string>();

async function createTempChannel(ctx: BotContext, member: GuildMember, creator: VoiceChannel) {
  const guild = member.guild;
  const key = `${guild.id}:${member.id}`;
  if (creating.has(key)) return;
  creating.add(key);
  try {
    const { config: cfg } = await ctx.config.get(guild.id, 'voice');
    const me = guild.members.me!;
    if (!me.permissions.has([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers])) {
      log.warn({ guild: guild.id }, 'Voice-Manager: Berechtigungen „Kanäle verwalten“ und „Mitglieder verschieben“ fehlen');
      return;
    }
    // Bereits einen eigenen Kanal? Dann dorthin verschieben
    const existing = await prisma.tempVoiceChannel.findFirst({ where: { guildId: guild.id, ownerId: member.id } });
    if (existing && guild.channels.cache.has(existing.channelId)) {
      await member.voice.setChannel(existing.channelId).catch(() => undefined);
      return;
    }
    const parentId = cfg.categoryId && guild.channels.cache.get(cfg.categoryId)?.type === ChannelType.GuildCategory ? cfg.categoryId : creator.parentId;
    const name = renderTemplate(cfg.nameTemplate, { user: member.displayName, username: member.user.username }).slice(0, 100) || `${member.displayName}s Kanal`;
    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: parentId ?? undefined,
      userLimit: cfg.defaultLimit,
      bitrate: creator.bitrate,
      permissionOverwrites: [
        ...(creator.parent?.permissionOverwrites.cache.map((o) => ({ id: o.id, allow: o.allow, deny: o.deny, type: o.type })) ?? []),
        { id: member.id, allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.Stream], type: OverwriteType.Member },
        { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers], type: OverwriteType.Member },
      ],
      reason: `Temporärer Kanal für ${member.user.username}`,
    });
    await prisma.tempVoiceChannel.create({ data: { channelId: channel.id, guildId: guild.id, ownerId: member.id, creatorId: creator.id } });
    await member.voice.setChannel(channel).catch(async () => {
      // Nutzer hat den Kanal schon verlassen → sofort wieder löschen
      await channel.delete().catch(() => undefined);
      await prisma.tempVoiceChannel.deleteMany({ where: { channelId: channel.id } });
    });
    ctx.live(guild.id, 'voice.created', { channelId: channel.id, name: channel.name, ownerId: member.id });
  } finally {
    creating.delete(key);
  }
}

async function scheduleDeleteIfEmpty(ctx: BotContext, guild: Guild, channelId: string) {
  const temp = await prisma.tempVoiceChannel.findUnique({ where: { channelId } });
  if (!temp) return;
  const channel = guild.channels.cache.get(channelId) as VoiceChannel | undefined;
  if (channel && channel.members.size > 0) return;
  const { config: cfg } = await ctx.config.get(guild.id, 'voice');
  const doDelete = async () => {
    pendingDeletes.delete(channelId);
    const ch = guild.channels.cache.get(channelId) as VoiceChannel | undefined;
    if (ch && ch.members.size > 0) return;
    await ch?.delete('Temporärer Kanal leer').catch(() => undefined);
    await prisma.tempVoiceChannel.deleteMany({ where: { channelId } });
    ctx.live(guild.id, 'voice.deleted', { channelId });
  };
  if (cfg.deleteDelaySeconds > 0) {
    clearTimeout(pendingDeletes.get(channelId));
    pendingDeletes.set(channelId, setTimeout(() => void doDelete(), cfg.deleteDelaySeconds * 1000));
  } else {
    await doDelete();
  }
}

async function ownedChannel(member: GuildMember, requireOwner = true) {
  const channelId = member.voice.channelId;
  if (!channelId) throw new RpcError('VALIDATION', 'Du bist in keinem Sprachkanal.');
  const temp = await prisma.tempVoiceChannel.findUnique({ where: { channelId } });
  if (!temp) throw new RpcError('VALIDATION', 'Das ist kein temporärer Kanal.');
  if (requireOwner && temp.ownerId !== member.id) throw new RpcError('FORBIDDEN', 'Nur der Besitzer des Kanals kann das.');
  return { temp, channel: member.guild.channels.cache.get(channelId) as VoiceChannel };
}

export const voiceModule: BotModule = {
  id: 'voice',

  async onReady(ctx) {
    // Aufräumen nach Neustart: verwaiste oder leere temporäre Kanäle entfernen
    const all = await prisma.tempVoiceChannel.findMany();
    for (const t of all) {
      const guild = ctx.client.guilds.cache.get(t.guildId);
      const ch = guild?.channels.cache.get(t.channelId) as VoiceChannel | undefined;
      if (!ch) {
        await prisma.tempVoiceChannel.delete({ where: { channelId: t.channelId } }).catch(() => undefined);
      } else if (ch.members.size === 0) {
        await ch.delete('Temporärer Kanal leer (Aufräumen nach Neustart)').catch(() => undefined);
        await prisma.tempVoiceChannel.delete({ where: { channelId: t.channelId } }).catch(() => undefined);
      }
    }
  },

  events: {
    async voiceStateUpdate(ctx, oldState, newState) {
      const guild = newState.guild;
      const cfg = await ctx.config.ifEnabled(guild.id, 'voice');
      if (!cfg) return;
      if (oldState.channelId === newState.channelId) return;

      if (newState.channelId && newState.member && cfg.creatorChannelIds.includes(newState.channelId)) {
        const creator = newState.channel as VoiceChannel;
        await createTempChannel(ctx, newState.member, creator);
      }
      if (newState.channelId && pendingDeletes.has(newState.channelId)) {
        clearTimeout(pendingDeletes.get(newState.channelId));
        pendingDeletes.delete(newState.channelId);
      }
      if (oldState.channelId && !cfg.creatorChannelIds.includes(oldState.channelId)) {
        await scheduleDeleteIfEmpty(ctx, guild, oldState.channelId);
      }
    },
    async channelDelete(ctx, channel) {
      if (channel.isDMBased()) return;
      const res = await prisma.tempVoiceChannel.deleteMany({ where: { channelId: channel.id } });
      if (res.count) ctx.live(channel.guildId, 'voice.deleted', { channelId: channel.id });
    },
  },

  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Eigenen temporären Sprachkanal verwalten')
        .addSubcommand((s) => s.setName('name').setDescription('Kanal umbenennen').addStringOption((o) => o.setName('name').setDescription('Neuer Name').setRequired(true).setMaxLength(100)))
        .addSubcommand((s) => s.setName('limit').setDescription('Benutzerlimit setzen (0 = unbegrenzt)').addIntegerOption((o) => o.setName('anzahl').setDescription('0–99').setRequired(true).setMinValue(0).setMaxValue(99)))
        .addSubcommand((s) => s.setName('lock').setDescription('Kanal sperren'))
        .addSubcommand((s) => s.setName('unlock').setDescription('Kanal entsperren'))
        .addSubcommand((s) => s.setName('claim').setDescription('Kanal übernehmen, wenn der Besitzer weg ist'))
        .addSubcommand((s) => s.setName('transfer').setDescription('Besitz übertragen').addUserOption((o) => o.setName('mitglied').setDescription('Neuer Besitzer').setRequired(true)))
        .addSubcommand((s) => s.setName('kick').setDescription('Mitglied aus dem Kanal werfen').addUserOption((o) => o.setName('mitglied').setDescription('Mitglied').setRequired(true)))
        .toJSON(),
      async execute(i, ctx) {
        const { config: cfg } = await ctx.config.get(i.guildId, 'voice');
        const sub = i.options.getSubcommand();
        const reply = (text: string, ok = true) => i.reply({ embeds: [ok ? success(text) : failure(text)], flags: MessageFlags.Ephemeral });

        if (sub === 'claim') {
          const { temp, channel } = await ownedChannel(i.member, false);
          if (temp.ownerId === i.user.id) return void (await reply('Der Kanal gehört dir bereits.'));
          if (channel.members.has(temp.ownerId)) return void (await reply('Der Besitzer ist noch im Kanal.', false));
          await prisma.tempVoiceChannel.update({ where: { channelId: channel.id }, data: { ownerId: i.user.id } });
          await channel.permissionOverwrites.edit(i.user.id, { Connect: true, Speak: true, MoveMembers: true, Stream: true });
          await channel.permissionOverwrites.delete(temp.ownerId).catch(() => undefined);
          return void (await reply('Du bist jetzt Besitzer dieses Kanals.'));
        }

        const { temp, channel } = await ownedChannel(i.member);
        switch (sub) {
          case 'name':
            if (!cfg.allowRename) return void (await reply('Umbenennen ist deaktiviert.', false));
            await channel.setName(i.options.getString('name', true));
            return void (await reply('Kanal umbenannt. (Discord erlaubt 2 Umbenennungen pro 10 Minuten.)'));
          case 'limit':
            if (!cfg.allowLimit) return void (await reply('Limits sind deaktiviert.', false));
            await channel.setUserLimit(i.options.getInteger('anzahl', true));
            return void (await reply('Limit gesetzt.'));
          case 'lock':
          case 'unlock':
            if (!cfg.allowLock) return void (await reply('Sperren ist deaktiviert.', false));
            await channel.permissionOverwrites.edit(i.guild.roles.everyone.id, { Connect: sub === 'lock' ? false : null });
            await prisma.tempVoiceChannel.update({ where: { channelId: channel.id }, data: { locked: sub === 'lock' } });
            return void (await reply(sub === 'lock' ? '🔒 Kanal gesperrt.' : '🔓 Kanal entsperrt.'));
          case 'transfer': {
            const target = i.options.getMember('mitglied');
            if (!target || target.user.bot || target.voice.channelId !== channel.id) return void (await reply('Das Mitglied muss in deinem Kanal sein.', false));
            await prisma.tempVoiceChannel.update({ where: { channelId: channel.id }, data: { ownerId: target.id } });
            await channel.permissionOverwrites.edit(target.id, { Connect: true, Speak: true, MoveMembers: true, Stream: true });
            await channel.permissionOverwrites.delete(temp.ownerId).catch(() => undefined);
            return void (await reply(`<@${target.id}> ist jetzt Besitzer.`));
          }
          case 'kick': {
            const target = i.options.getMember('mitglied');
            if (!target || target.voice.channelId !== channel.id) return void (await reply('Das Mitglied ist nicht in deinem Kanal.', false));
            if (target.id === i.user.id) return void (await reply('Du kannst dich nicht selbst entfernen.', false));
            await target.voice.disconnect('Vom Kanalbesitzer entfernt');
            await channel.permissionOverwrites.edit(target.id, { Connect: false });
            return void (await reply(`<@${target.id}> wurde entfernt.`));
          }
        }
      },
    },
  ],

  rpc: {
    async 'voice.list'(p, ctx) {
      const guild = getGuild(ctx, p.guildId);
      const temps = await prisma.tempVoiceChannel.findMany({ where: { guildId: guild.id }, orderBy: { createdAt: 'desc' } });
      const temporary = temps
        .map((t) => {
          const ch = guild.channels.cache.get(t.channelId) as VoiceChannel | undefined;
          if (!ch) return null;
          return {
            channelId: t.channelId,
            name: ch.name,
            ownerId: t.ownerId,
            locked: t.locked,
            userLimit: ch.userLimit,
            createdAt: t.createdAt.toISOString(),
            members: ch.members.map((m) => ({ id: m.id, username: m.displayName, avatar: m.displayAvatarURL({ size: 64 }), muted: !!m.voice.mute, deaf: !!m.voice.deaf })),
          };
        })
        .filter(Boolean);
      const active = guild.channels.cache
        .filter((c) => (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) && (c as VoiceChannel).members.size > 0)
        .map((c) => ({ channelId: c.id, name: c.name, members: (c as VoiceChannel).members.size }));
      return { temporary, active, totalInVoice: guild.voiceStates.cache.filter((v) => !!v.channelId).size };
    },
    async 'voice.delete'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, channelId: snowflake }), p);
      const guild = getGuild(ctx, input.guildId);
      const temp = await prisma.tempVoiceChannel.findUnique({ where: { channelId: input.channelId } });
      if (!temp || temp.guildId !== guild.id) throw new RpcError('NOT_FOUND', 'Temporärer Kanal nicht gefunden.');
      await guild.channels.cache.get(input.channelId)?.delete('Über das Dashboard gelöscht').catch(() => undefined);
      await prisma.tempVoiceChannel.deleteMany({ where: { channelId: input.channelId } });
      return { ok: true };
    },
  },
};
