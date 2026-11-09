import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type GuildTextBasedChannel } from 'discord.js';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../shared/prisma';
import { RpcError } from '../../shared/bus';
import { snowflake } from '../../shared/modules';
import type { BotContext, BotModule } from '../core/types';
import { embed as baseEmbed, hexToInt, success } from '../utils/embeds';
import { getGuild, parse } from './core';

/**
 * Nachrichten als Bot senden und bearbeiten (über das Dashboard).
 * Gesendete Nachrichten werden in ModuleData (moduleKey "messages") gespeichert,
 * damit sie später im Dashboard bearbeitet oder gelöscht werden können.
 */

const MODULE_KEY = 'messages';

const embedSchema = z.object({
  title: z.string().max(256).default(''),
  description: z.string().max(4000).default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
  url: z.string().url().max(500).or(z.literal('')).default(''),
  imageUrl: z.string().url().max(500).or(z.literal('')).default(''),
  thumbnailUrl: z.string().url().max(500).or(z.literal('')).default(''),
  footer: z.string().max(2048).default(''),
  timestamp: z.boolean().default(false),
  fields: z.array(z.object({ name: z.string().min(1).max(256), value: z.string().min(1).max(1024), inline: z.boolean().default(false) })).max(25).default(() => []),
});

export const messagePayloadSchema = z
  .object({
    content: z.string().max(2000).default(''),
    embed: embedSchema.nullable().default(null),
    /** Erlaubte Erwähnungen: none = keine Pings, users = nur Nutzer, all = auch Rollen/@everyone */
    mentions: z.enum(['none', 'users', 'all']).default('users'),
  })
  .refine((p) => p.content.trim().length > 0 || (p.embed && (p.embed.title || p.embed.description || p.embed.imageUrl || p.embed.fields.length)), {
    message: 'Die Nachricht ist leer.',
  });
export type MessagePayload = z.infer<typeof messagePayloadSchema>;

function build(p: MessagePayload) {
  const embeds = [];
  if (p.embed) {
    const e = baseEmbed(hexToInt(p.embed.color)).setTimestamp(p.embed.timestamp ? new Date() : null);
    if (p.embed.title) e.setTitle(p.embed.title);
    if (p.embed.url && p.embed.title) e.setURL(p.embed.url);
    if (p.embed.description) e.setDescription(p.embed.description);
    if (p.embed.imageUrl) e.setImage(p.embed.imageUrl);
    if (p.embed.thumbnailUrl) e.setThumbnail(p.embed.thumbnailUrl);
    if (p.embed.footer) e.setFooter({ text: p.embed.footer });
    if (p.embed.fields.length) e.addFields(p.embed.fields);
    embeds.push(e);
  }
  const allowedMentions = p.mentions === 'all' ? { parse: ['users', 'roles', 'everyone'] as ('users' | 'roles' | 'everyone')[] } : p.mentions === 'users' ? { parse: ['users'] as 'users'[] } : { parse: [] };
  return { content: p.content || undefined, embeds, allowedMentions };
}

async function channelFor(ctx: BotContext, guildId: string, channelId: string): Promise<GuildTextBasedChannel> {
  const guild = getGuild(ctx, guildId);
  const ch = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  if (!ch || !ch.isTextBased()) throw new RpcError('NOT_FOUND', 'Kanal nicht gefunden.');
  const perms = ch.permissionsFor(guild.members.me!);
  if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) throw new RpcError('MISSING_PERMISSIONS', `Der Bot darf in #${ch.name} nicht schreiben.`);
  return ch as GuildTextBasedChannel;
}

async function remember(guildId: string, messageId: string, value: Record<string, unknown>) {
  await prisma.moduleData.upsert({
    where: { guildId_moduleKey_key: { guildId, moduleKey: MODULE_KEY, key: messageId } },
    create: { guildId, moduleKey: MODULE_KEY, key: messageId, value: value as Prisma.InputJsonValue },
    update: { value: value as Prisma.InputJsonValue },
  });
}

export const messagesModule: BotModule = {
  id: 'core',
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('say')
        .setDescription('Lässt den Bot eine Nachricht senden')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addStringOption((o) => o.setName('nachricht').setDescription('Text (\\n für Zeilenumbruch)').setRequired(true).setMaxLength(2000))
        .addChannelOption((o) => o.setName('kanal').setDescription('Zielkanal (Standard: dieser Kanal)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addBooleanOption((o) => o.setName('embed').setDescription('Als Embed senden'))
        .toJSON(),
      async execute(i, ctx) {
        const target = i.options.getChannel('kanal') ?? i.channel;
        if (!target) throw new RpcError('VALIDATION', 'Kein Zielkanal.');
        const ch = await channelFor(ctx, i.guildId, target.id);
        if (!ch.permissionsFor(i.member)?.has(PermissionFlagsBits.SendMessages)) throw new RpcError('FORBIDDEN', 'Du darfst in diesem Kanal selbst nicht schreiben.');
        const text = i.options.getString('nachricht', true).replace(/\\n/g, '\n');
        const payload = messagePayloadSchema.parse(i.options.getBoolean('embed') ? { embed: { description: text } } : { content: text });
        const msg = await ch.send(build(payload));
        await remember(i.guildId, msg.id, { channelId: ch.id, channelName: ch.name, payload, sentBy: i.user.id, sentAt: msg.createdAt.toISOString(), editedAt: null, url: msg.url });
        await i.reply({ embeds: [success(`Nachricht gesendet: ${msg.url}`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],
  rpc: {
    async 'message.send'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, channelId: snowflake, actorId: snowflake, payload: messagePayloadSchema }), p);
      const ch = await channelFor(ctx, input.guildId, input.channelId);
      if (input.payload.embed && !ch.permissionsFor(ch.guild.members.me!)?.has(PermissionFlagsBits.EmbedLinks)) throw new RpcError('MISSING_PERMISSIONS', 'Dem Bot fehlt in diesem Kanal „Links einbetten“.');
      if (input.payload.mentions === 'all' && !ch.permissionsFor(ch.guild.members.me!)?.has(PermissionFlagsBits.MentionEveryone)) throw new RpcError('MISSING_PERMISSIONS', 'Dem Bot fehlt „@everyone erwähnen“.');
      const msg = await ch.send(build(input.payload));
      await remember(input.guildId, msg.id, { channelId: ch.id, channelName: ch.name, payload: input.payload, sentBy: input.actorId, sentAt: msg.createdAt.toISOString(), editedAt: null, url: msg.url });
      await ctx.logs.write({ guildId: input.guildId, category: 'server', type: 'bot_message', summary: `Nachricht als Bot in <#${ch.id}> gesendet`, actorId: input.actorId, channelId: ch.id, data: { messageId: msg.id } });
      return { messageId: msg.id, url: msg.url };
    },
    /** Schnell-Umfrage (Quick Action): native Discord-Umfrage senden */
    async 'message.poll'(p, ctx) {
      const input = parse(
        z.object({
          guildId: snowflake,
          channelId: snowflake,
          actorId: snowflake,
          question: z.string().min(1).max(300),
          answers: z.array(z.string().min(1).max(55)).min(2).max(10),
          durationHours: z.number().int().min(1).max(768).default(24),
          allowMultiselect: z.boolean().default(false),
        }),
        p,
      );
      const ch = await channelFor(ctx, input.guildId, input.channelId);
      if (!ch.permissionsFor(ch.guild.members.me!)?.has(PermissionFlagsBits.SendPolls)) throw new RpcError('MISSING_PERMISSIONS', 'Dem Bot fehlt die Berechtigung „Umfragen erstellen“.');
      const msg = await ch.send({ poll: { question: { text: input.question }, answers: input.answers.map((text) => ({ text })), duration: input.durationHours, allowMultiselect: input.allowMultiselect } });
      await ctx.logs.write({ guildId: input.guildId, category: 'server', type: 'bot_message', summary: `Umfrage „${input.question}“ in <#${ch.id}> gestartet`, actorId: input.actorId, channelId: ch.id, data: { messageId: msg.id } });
      return { messageId: msg.id, url: msg.url };
    },
    async 'message.edit'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, messageId: snowflake, actorId: snowflake, payload: messagePayloadSchema }), p);
      const row = await prisma.moduleData.findUnique({ where: { guildId_moduleKey_key: { guildId: input.guildId, moduleKey: MODULE_KEY, key: input.messageId } } });
      if (!row) throw new RpcError('NOT_FOUND', 'Nachricht nicht gefunden.');
      const stored = row.value as { channelId: string };
      const ch = await channelFor(ctx, input.guildId, stored.channelId);
      const msg = await ch.messages.fetch(input.messageId).catch(() => null);
      if (!msg) throw new RpcError('NOT_FOUND', 'Die Nachricht existiert in Discord nicht mehr.');
      await msg.edit({ ...build(input.payload), content: input.payload.content || null });
      await remember(input.guildId, msg.id, { ...(row.value as object), payload: input.payload, editedAt: new Date().toISOString() });
      return { messageId: msg.id, url: msg.url };
    },
    async 'message.delete'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, messageId: snowflake }), p);
      const row = await prisma.moduleData.findUnique({ where: { guildId_moduleKey_key: { guildId: input.guildId, moduleKey: MODULE_KEY, key: input.messageId } } });
      if (!row) throw new RpcError('NOT_FOUND', 'Nachricht nicht gefunden.');
      const ch = await channelFor(ctx, input.guildId, (row.value as { channelId: string }).channelId).catch(() => null);
      const msg = ch ? await ch.messages.fetch(input.messageId).catch(() => null) : null;
      await msg?.delete().catch(() => undefined);
      await prisma.moduleData.delete({ where: { guildId_moduleKey_key: { guildId: input.guildId, moduleKey: MODULE_KEY, key: input.messageId } } });
      return { ok: true };
    },
  },
};
