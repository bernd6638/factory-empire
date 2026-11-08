import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  OverwriteType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Guild,
  type GuildMember,
  type TextChannel,
  type OverwriteResolvable,
} from 'discord.js';
import { Prisma, type Ticket, type TicketPriority } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../shared/prisma';
import { renderTemplate } from '../../shared/template';
import { RpcError } from '../../shared/bus';
import { snowflake, type ModuleConfig, type TicketCategory } from '../../shared/modules';
import { env } from '../../shared/env';
import { childLogger } from '../../shared/logger';
import type { BotContext, BotModule, ComponentInteraction } from '../core/types';
import { COLORS, embed, failure, hexToInt, success, truncate } from '../utils/embeds';
import { getSendableChannel, requireBotPermission } from '../utils/discord';
import { getGuild, parse } from './core';

const log = childLogger('tickets');
type TicketsConfig = ModuleConfig<'tickets'>;

/** Offene Ticket-Kanäle (channelId → ticketId) – vermeidet Datenbankabfragen bei jeder Nachricht. */
const openTicketChannels = new Map<string, number>();

const PRIORITY_LABEL: Record<TicketPriority, string> = { LOW: '🟢 Niedrig', NORMAL: '🔵 Normal', HIGH: '🟠 Hoch', URGENT: '🔴 Dringend' };
const PRIORITY_COLOR: Record<TicketPriority, number> = { LOW: COLORS.success, NORMAL: COLORS.info, HIGH: COLORS.warning, URGENT: COLORS.danger };

function serializeTicket(t: Ticket) {
  return { ...t, createdAt: t.createdAt.toISOString(), claimedAt: t.claimedAt?.toISOString() ?? null, closedAt: t.closedAt?.toISOString() ?? null };
}

function supportRolesFor(cfg: TicketsConfig, category: TicketCategory | undefined) {
  return [...new Set([...cfg.supportRoleIds, ...(category?.supportRoleIds ?? [])])];
}

function isSupporter(member: GuildMember, cfg: TicketsConfig, ticket?: Ticket) {
  if (member.permissions.has(PermissionFlagsBits.ManageChannels)) return true;
  const cat = ticket ? cfg.categories.find((c) => c.key === ticket.categoryKey) : undefined;
  return supportRolesFor(cfg, cat).some((r) => member.roles.cache.has(r));
}

function ticketControls(ticket: Ticket) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`tickets:claim:${ticket.id}`).setLabel('Übernehmen').setEmoji('🙋').setStyle(ButtonStyle.Primary).setDisabled(ticket.status !== 'OPEN'),
      new ButtonBuilder().setCustomId(`tickets:close:${ticket.id}`).setLabel('Schließen').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`tickets:priority:${ticket.id}`)
        .setPlaceholder(`Priorität: ${PRIORITY_LABEL[ticket.priority]}`)
        .addOptions((Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((p) => ({ label: PRIORITY_LABEL[p], value: p, default: p === ticket.priority }))),
    ),
  ];
}

async function nextNumber(guildId: string) {
  const last = await prisma.ticket.findFirst({ where: { guildId }, orderBy: { number: 'desc' }, select: { number: true } });
  return (last?.number ?? 0) + 1;
}

/** Erstellt ein neues Ticket inkl. privatem Kanal. */
async function createTicket(ctx: BotContext, member: GuildMember, categoryKey: string, subject: string | null): Promise<{ ticket: Ticket; channel: TextChannel }> {
  const guild = member.guild;
  const { config: cfg } = await ctx.config.get(guild.id, 'tickets');
  const category = cfg.categories.find((c) => c.key === categoryKey);
  if (!category) throw new RpcError('NOT_FOUND', 'Diese Ticket-Kategorie existiert nicht mehr.');

  requireBotPermission(guild, PermissionFlagsBits.ManageChannels, 'Kanäle verwalten');
  requireBotPermission(guild, PermissionFlagsBits.ManageRoles, 'Rollen verwalten');

  const open = await prisma.ticket.count({ where: { guildId: guild.id, ownerId: member.id, status: { in: ['OPEN', 'CLAIMED'] } } });
  if (open >= cfg.maxOpenPerUser) throw new RpcError('LIMIT', `Du hast bereits ${open} offene(s) Ticket(s). Bitte schließe zuerst ein bestehendes.`);

  const parent = cfg.categoryChannelId ? guild.channels.cache.get(cfg.categoryChannelId) : null;
  const supportRoles = supportRolesFor(cfg, category).filter((id) => guild.roles.cache.has(id));
  const me = guild.members.me!;

  const overwrites: OverwriteResolvable[] = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel], type: OverwriteType.Role },
    {
      id: me.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles],
      type: OverwriteType.Member,
    },
    {
      id: member.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks],
      type: OverwriteType.Member,
    },
    ...supportRoles.map((id) => ({
      id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages],
      type: OverwriteType.Role,
    })),
  ];

  let ticket: Ticket | null = null;
  for (let attempt = 0; attempt < 5 && !ticket; attempt++) {
    try {
      ticket = await prisma.ticket.create({
        data: { guildId: guild.id, number: await nextNumber(guild.id), ownerId: member.id, ownerTag: member.user.username, categoryKey, subject },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
  }
  if (!ticket) throw new Error('Ticketnummer konnte nicht vergeben werden');

  const name = renderTemplate(cfg.namePattern, { number: String(ticket.number).padStart(4, '0'), user: member.user.username, username: member.user.username, category: category.key })
    .toLowerCase()
    .replace(/[^a-z0-9\-_]/g, '-')
    .slice(0, 90);

  let channel: TextChannel;
  try {
    channel = await guild.channels.create({
      name: name || `ticket-${ticket.number}`,
      type: ChannelType.GuildText,
      parent: parent?.type === ChannelType.GuildCategory ? parent.id : undefined,
      topic: `Ticket #${ticket.number} • ${category.label} • ${member.user.username} (${member.id})`,
      permissionOverwrites: overwrites,
      reason: `Ticket #${ticket.number}`,
    });
  } catch (err: any) {
    await prisma.ticket.delete({ where: { id: ticket.id } });
    throw new RpcError('DISCORD_ERROR', `Ticket-Kanal konnte nicht erstellt werden: ${err?.message ?? err}`);
  }
  ticket = await prisma.ticket.update({ where: { id: ticket.id }, data: { channelId: channel.id } });
  openTicketChannels.set(channel.id, ticket.id);

  const welcome = renderTemplate(category.welcomeMessage || cfg.defaultWelcome, { user: `<@${member.id}>`, username: member.user.username, server: guild.name, category: category.label });
  const e = embed(PRIORITY_COLOR[ticket.priority])
    .setTitle(`${category.emoji ? `${category.emoji} ` : ''}Ticket #${ticket.number} – ${category.label}`)
    .setDescription(welcome)
    .addFields({ name: 'Erstellt von', value: `<@${member.id}>`, inline: true }, { name: 'Priorität', value: PRIORITY_LABEL[ticket.priority], inline: true });
  if (subject) e.addFields({ name: 'Betreff', value: truncate(subject, 1024) });

  const pings = [`<@${member.id}>`, ...(cfg.pingSupport ? supportRoles.map((r) => `<@&${r}>`) : [])].join(' ');
  await channel.send({ content: pings, embeds: [e], components: ticketControls(ticket), allowedMentions: { users: [member.id], roles: cfg.pingSupport ? supportRoles : [] } });

  ctx.live(guild.id, 'ticket.created', serializeTicket(ticket));
  await ctx.logs.write({
    guildId: guild.id,
    category: 'server',
    type: 'ticket',
    summary: `Ticket #${ticket.number} (${category.label}) eröffnet von ${member.user.username}`,
    actorId: member.id,
    channelId: channel.id,
    data: { ticketId: ticket.id, number: ticket.number, action: 'created' },
    color: COLORS.info,
  });
  return { ticket, channel };
}

/** Lädt alle Nachrichten eines Kanals (bis zu `max`) in chronologischer Reihenfolge. */
async function fetchAllMessages(channel: TextChannel, max = 2000) {
  const all = [];
  let before: string | undefined;
  while (all.length < max) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last()!.id;
    if (batch.size < 100) break;
  }
  return all.reverse();
}

function transcriptText(ticket: Ticket, guild: Guild, rows: { authorTag: string; content: string; createdAt: Date; attachments: unknown }[]) {
  const head = [`Transkript – Ticket #${ticket.number}`, `Server: ${guild.name}`, `Ersteller: ${ticket.ownerTag ?? ticket.ownerId}`, `Kategorie: ${ticket.categoryKey}`, `Erstellt: ${ticket.createdAt.toISOString()}`, ''.padEnd(60, '─')];
  const body = rows.map((r) => {
    const att = Array.isArray(r.attachments) && r.attachments.length ? `\n    📎 ${(r.attachments as { url: string }[]).map((a) => a.url).join('\n    📎 ')}` : '';
    return `[${r.createdAt.toISOString().replace('T', ' ').slice(0, 19)}] ${r.authorTag}: ${r.content}${att}`;
  });
  return [...head, ...body].join('\n');
}

/** Schließt ein Ticket: Transkript speichern, Kanal löschen oder archivieren. */
async function closeTicket(ctx: BotContext, ticketId: number, closedById: string, reason: string | null) {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new RpcError('NOT_FOUND', 'Ticket nicht gefunden.');
  if (ticket.status === 'CLOSED') throw new RpcError('VALIDATION', 'Dieses Ticket ist bereits geschlossen.');
  const guild = getGuild(ctx, ticket.guildId);
  const { config: cfg } = await ctx.config.get(guild.id, 'tickets');
  const channel = ticket.channelId ? (guild.channels.cache.get(ticket.channelId) as TextChannel | undefined) : undefined;

  let messageCount = 0;
  let transcript = '';
  if (channel) {
    const messages = await fetchAllMessages(channel).catch(() => []);
    const rows = messages.map((m) => ({
      ticketId: ticket.id,
      messageId: m.id,
      authorId: m.author.id,
      authorTag: m.author.username,
      authorBot: m.author.bot,
      content: m.content || (m.embeds[0]?.description ?? m.embeds[0]?.title ?? ''),
      attachments: m.attachments.map((a) => ({ name: a.name, url: a.url, size: a.size })) as Prisma.InputJsonValue,
      embeds: m.embeds.map((e) => ({ title: e.title, description: e.description })) as Prisma.InputJsonValue,
      createdAt: m.createdAt,
    }));
    await prisma.ticketMessage.deleteMany({ where: { ticketId: ticket.id } });
    if (rows.length) await prisma.ticketMessage.createMany({ data: rows });
    messageCount = rows.length;
    transcript = transcriptText(ticket, guild, rows);
  }

  if (ticket.channelId) openTicketChannels.delete(ticket.channelId);
  const updated = await prisma.ticket.update({
    where: { id: ticket.id },
    data: { status: 'CLOSED', closedAt: new Date(), closedById, closeReason: reason, archived: cfg.closeAction === 'archive' },
  });

  const dashboardUrl = `${env().PUBLIC_URL}/guild/${guild.id}/tickets?ticket=${ticket.id}`;
  const summary = embed(COLORS.muted)
    .setTitle(`🔒 Ticket #${ticket.number} geschlossen`)
    .addFields(
      { name: 'Ersteller', value: `<@${ticket.ownerId}>`, inline: true },
      { name: 'Geschlossen von', value: `<@${closedById}>`, inline: true },
      { name: 'Nachrichten', value: String(messageCount), inline: true },
      { name: 'Grund', value: reason ?? 'Kein Grund angegeben' },
    )
    .setURL(dashboardUrl);
  const file = transcript ? new AttachmentBuilder(Buffer.from(transcript, 'utf8'), { name: `ticket-${ticket.number}.txt` }) : null;

  const transcriptChannel = await getSendableChannel(guild, cfg.transcriptChannelId);
  await transcriptChannel?.send({ embeds: [summary], files: file ? [file] : [], allowedMentions: { parse: [] } }).catch(() => undefined);

  const owner = await ctx.client.users.fetch(ticket.ownerId).catch(() => null);
  await owner?.send({ content: `Dein Ticket auf **${guild.name}** wurde geschlossen.`, embeds: [summary], files: file ? [file] : [] }).catch(() => undefined);

  if (channel) {
    if (cfg.closeAction === 'archive') {
      await channel.send({ embeds: [embed(COLORS.muted).setDescription(`🔒 Ticket geschlossen von <@${closedById}>.${reason ? `\n**Grund:** ${reason}` : ''}`)] }).catch(() => undefined);
      await channel.permissionOverwrites.edit(ticket.ownerId, { SendMessages: false }).catch(() => undefined);
      const archive = cfg.archiveCategoryId ? guild.channels.cache.get(cfg.archiveCategoryId) : null;
      await channel
        .edit({ name: `closed-${ticket.number}`, parent: archive?.type === ChannelType.GuildCategory ? archive.id : channel.parentId, lockPermissions: false })
        .catch(() => undefined);
    } else {
      await channel.send({ embeds: [embed(COLORS.muted).setDescription('🔒 Ticket wird in 5 Sekunden gelöscht …')] }).catch(() => undefined);
      setTimeout(() => void channel.delete(`Ticket #${ticket.number} geschlossen`).catch(() => undefined), 5000);
    }
  }

  ctx.live(guild.id, 'ticket.updated', serializeTicket(updated));
  await ctx.logs.write({
    guildId: guild.id,
    category: 'server',
    type: 'ticket',
    summary: `Ticket #${ticket.number} geschlossen${reason ? `: ${reason}` : ''}`,
    actorId: closedById,
    targetId: ticket.ownerId,
    data: { ticketId: ticket.id, number: ticket.number, action: 'closed', messages: messageCount },
    color: COLORS.muted,
  });
  return updated;
}

async function claimTicket(ctx: BotContext, ticketId: number, userId: string) {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket || ticket.status === 'CLOSED') throw new RpcError('NOT_FOUND', 'Ticket nicht gefunden oder bereits geschlossen.');
  const updated = await prisma.ticket.update({ where: { id: ticketId }, data: { assigneeId: userId, status: 'CLAIMED', claimedAt: ticket.claimedAt ?? new Date() } });
  const guild = getGuild(ctx, ticket.guildId);
  const channel = ticket.channelId ? (guild.channels.cache.get(ticket.channelId) as TextChannel | undefined) : undefined;
  await channel?.send({ embeds: [embed(COLORS.brand).setDescription(`🙋 <@${userId}> kümmert sich um dieses Ticket.`)] }).catch(() => undefined);
  ctx.live(guild.id, 'ticket.updated', serializeTicket(updated));
  return updated;
}

async function setPriority(ctx: BotContext, ticketId: number, priority: TicketPriority, byId: string) {
  const ticket = await prisma.ticket.update({ where: { id: ticketId }, data: { priority } });
  const guild = getGuild(ctx, ticket.guildId);
  const channel = ticket.channelId ? (guild.channels.cache.get(ticket.channelId) as TextChannel | undefined) : undefined;
  await channel?.send({ embeds: [embed(PRIORITY_COLOR[priority]).setDescription(`Priorität auf **${PRIORITY_LABEL[priority]}** gesetzt von <@${byId}>.`)] }).catch(() => undefined);
  ctx.live(guild.id, 'ticket.updated', serializeTicket(ticket));
  return ticket;
}

async function sendPanel(ctx: BotContext, guild: Guild) {
  const { config: cfg } = await ctx.config.get(guild.id, 'tickets');
  if (!cfg.panel.channelId) throw new RpcError('VALIDATION', 'Bitte zuerst einen Kanal für das Ticket-Panel festlegen.');
  const channel = await getSendableChannel(guild, cfg.panel.channelId);
  if (!channel) throw new RpcError('MISSING_PERMISSIONS', 'Der Bot kann im Panel-Kanal keine Nachrichten senden.');

  const e = embed(hexToInt(cfg.panel.color)).setTitle(cfg.panel.title).setDescription(cfg.panel.description).setFooter({ text: 'Discord OS • Tickets' });
  const components =
    cfg.categories.length <= 5
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            cfg.categories.map((c) => {
              const b = new ButtonBuilder().setCustomId(`tickets:open:${c.key}`).setLabel(c.label).setStyle(ButtonStyle.Secondary);
              if (c.emoji) b.setEmoji(c.emoji);
              return b;
            }),
          ),
        ]
      : [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('tickets:select')
              .setPlaceholder('Kategorie wählen …')
              .addOptions(cfg.categories.map((c) => ({ label: c.label, value: c.key, description: c.description || undefined, emoji: c.emoji || undefined }))),
          ),
        ];

  // Bestehendes Panel aktualisieren, sonst neu senden
  if (cfg.panel.messageId) {
    const existing = await channel.messages.fetch(cfg.panel.messageId).catch(() => null);
    if (existing) {
      await existing.edit({ embeds: [e], components });
      return { messageId: existing.id, updated: true };
    }
  }
  const msg = await channel.send({ embeds: [e], components });
  await ctx.config.patch(guild.id, 'tickets', (c) => {
    c.panel.messageId = msg.id;
  });
  return { messageId: msg.id, updated: false };
}

function openModal(categoryKey: string, label: string) {
  return new ModalBuilder()
    .setCustomId(`tickets:create:${categoryKey}`)
    .setTitle(truncate(`Ticket: ${label}`, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('subject').setLabel('Worum geht es?').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(false),
      ),
    );
}

async function handleComponent(i: ComponentInteraction, args: string[], ctx: BotContext) {
  const [action, arg] = args;
  const { config: cfg } = await ctx.config.get(i.guildId, 'tickets');

  if ((action === 'open' && i.isButton()) || (action === 'select' && i.isStringSelectMenu())) {
    const key = action === 'select' && i.isStringSelectMenu() ? i.values[0]! : arg!;
    const cat = cfg.categories.find((c) => c.key === key);
    if (!cat) throw new RpcError('NOT_FOUND', 'Diese Kategorie existiert nicht mehr.');
    await i.showModal(openModal(key, cat.label));
    return;
  }

  if (action === 'create' && i.isModalSubmit()) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const subject = i.fields.getTextInputValue('subject')?.trim() || null;
    const { channel } = await createTicket(ctx, i.member, arg!, subject);
    await i.editReply({ embeds: [success(`Dein Ticket wurde erstellt: <#${channel.id}>`)] });
    return;
  }

  const ticketId = Number(arg);
  const ticket = Number.isInteger(ticketId) ? await prisma.ticket.findUnique({ where: { id: ticketId } }) : null;
  if (!ticket || ticket.guildId !== i.guildId) throw new RpcError('NOT_FOUND', 'Ticket nicht gefunden.');

  if (action === 'claim' && i.isButton()) {
    if (!isSupporter(i.member, cfg, ticket)) throw new RpcError('FORBIDDEN', 'Nur das Support-Team kann Tickets übernehmen.');
    const updated = await claimTicket(ctx, ticket.id, i.user.id);
    await i.update({ components: ticketControls(updated) });
    return;
  }

  if (action === 'priority' && i.isStringSelectMenu()) {
    if (!isSupporter(i.member, cfg, ticket)) throw new RpcError('FORBIDDEN', 'Nur das Support-Team kann die Priorität ändern.');
    const updated = await setPriority(ctx, ticket.id, i.values[0] as TicketPriority, i.user.id);
    await i.update({ components: ticketControls(updated) });
    return;
  }

  if (action === 'close' && i.isButton()) {
    if (ticket.ownerId !== i.user.id && !isSupporter(i.member, cfg, ticket)) throw new RpcError('FORBIDDEN', 'Du darfst dieses Ticket nicht schließen.');
    await i.showModal(
      new ModalBuilder()
        .setCustomId(`tickets:closeconfirm:${ticket.id}`)
        .setTitle(`Ticket #${ticket.number} schließen`)
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Grund (optional)').setStyle(TextInputStyle.Short).setMaxLength(300).setRequired(false)),
        ),
    );
    return;
  }

  if (action === 'closeconfirm' && i.isModalSubmit()) {
    await i.deferReply();
    await closeTicket(ctx, ticket.id, i.user.id, i.fields.getTextInputValue('reason')?.trim() || null);
    await i.editReply({ embeds: [success('Ticket wurde geschlossen.')] }).catch(() => undefined);
  }
}

async function ticketFromChannel(i: { guildId: string; channelId: string | null }) {
  if (!i.channelId) return null;
  return prisma.ticket.findFirst({ where: { guildId: i.guildId, channelId: i.channelId, status: { in: ['OPEN', 'CLAIMED'] } } });
}

export const ticketsModule: BotModule = {
  id: 'tickets',
  components: [{ prefix: 'tickets', handle: handleComponent }],

  async onReady() {
    const open = await prisma.ticket.findMany({ where: { status: { in: ['OPEN', 'CLAIMED'] }, channelId: { not: null } }, select: { id: true, channelId: true } });
    for (const t of open) openTicketChannels.set(t.channelId!, t.id);
  },

  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Ticket-Verwaltung')
        .addSubcommand((s) => s.setName('add').setDescription('Mitglied zum Ticket hinzufügen').addUserOption((o) => o.setName('mitglied').setDescription('Mitglied').setRequired(true)))
        .addSubcommand((s) => s.setName('remove').setDescription('Mitglied aus dem Ticket entfernen').addUserOption((o) => o.setName('mitglied').setDescription('Mitglied').setRequired(true)))
        .addSubcommand((s) => s.setName('close').setDescription('Ticket schließen').addStringOption((o) => o.setName('grund').setDescription('Grund').setMaxLength(300)))
        .addSubcommand((s) => s.setName('claim').setDescription('Ticket übernehmen'))
        .addSubcommand((s) =>
          s
            .setName('priority')
            .setDescription('Priorität festlegen')
            .addStringOption((o) => o.setName('stufe').setDescription('Priorität').setRequired(true).addChoices(...(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((p) => ({ name: PRIORITY_LABEL[p], value: p })))),
        )
        .toJSON(),
      async execute(i, ctx) {
        const ticket = await ticketFromChannel(i);
        if (!ticket) {
          await i.reply({ embeds: [failure('Dieser Befehl funktioniert nur in einem offenen Ticket-Kanal.')], flags: MessageFlags.Ephemeral });
          return;
        }
        const { config: cfg } = await ctx.config.get(i.guildId, 'tickets');
        const sub = i.options.getSubcommand();
        const supporter = isSupporter(i.member, cfg, ticket);
        const channel = i.channel as TextChannel;

        if (sub === 'close') {
          if (ticket.ownerId !== i.user.id && !supporter) throw new RpcError('FORBIDDEN', 'Du darfst dieses Ticket nicht schließen.');
          await i.deferReply();
          await closeTicket(ctx, ticket.id, i.user.id, i.options.getString('grund'));
          await i.editReply({ embeds: [success('Ticket wurde geschlossen.')] }).catch(() => undefined);
          return;
        }
        if (!supporter) throw new RpcError('FORBIDDEN', 'Nur das Support-Team kann diesen Befehl verwenden.');
        if (sub === 'claim') {
          await claimTicket(ctx, ticket.id, i.user.id);
          await i.reply({ embeds: [success('Du hast das Ticket übernommen.')], flags: MessageFlags.Ephemeral });
        } else if (sub === 'priority') {
          await setPriority(ctx, ticket.id, i.options.getString('stufe', true) as TicketPriority, i.user.id);
          await i.reply({ embeds: [success('Priorität aktualisiert.')], flags: MessageFlags.Ephemeral });
        } else if (sub === 'add' || sub === 'remove') {
          const user = i.options.getUser('mitglied', true);
          if (sub === 'add') await channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
          else await channel.permissionOverwrites.delete(user.id);
          await i.reply({ embeds: [success(`<@${user.id}> wurde ${sub === 'add' ? 'hinzugefügt' : 'entfernt'}.`)] });
        }
      },
    },
  ],

  events: {
    async messageCreate(ctx, message) {
      if (!message.inGuild()) return;
      const ticketId = openTicketChannels.get(message.channelId);
      if (!ticketId) return;
      ctx.live(message.guildId, 'ticket.message', {
        ticketId,
        message: { id: message.id, authorId: message.author.id, authorTag: message.author.username, authorBot: message.author.bot, content: message.content, createdAt: message.createdAt.toISOString(), attachments: message.attachments.map((a) => ({ name: a.name, url: a.url })) },
      });
    },
    async channelDelete(ctx, channel) {
      if (channel.isDMBased()) return;
      openTicketChannels.delete(channel.id);
      const ticket = await prisma.ticket.findFirst({ where: { channelId: channel.id, status: { in: ['OPEN', 'CLAIMED'] } } });
      if (!ticket) return;
      const updated = await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'CLOSED', closedAt: new Date(), closeReason: 'Kanal wurde gelöscht' } });
      ctx.live(channel.guildId, 'ticket.updated', serializeTicket(updated));
    },
  },

  rpc: {
    async 'tickets.panel.send'(p, ctx) {
      return sendPanel(ctx, getGuild(ctx, p.guildId));
    },
    async 'tickets.close'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, ticketId: z.number().int(), actorId: snowflake, reason: z.string().max(300).nullable().optional() }), p);
      const t = await prisma.ticket.findUnique({ where: { id: input.ticketId } });
      if (!t || t.guildId !== input.guildId) throw new RpcError('NOT_FOUND', 'Ticket nicht gefunden.');
      return serializeTicket(await closeTicket(ctx, input.ticketId, input.actorId, input.reason ?? null));
    },
    async 'tickets.assign'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, ticketId: z.number().int(), assigneeId: snowflake }), p);
      const t = await prisma.ticket.findUnique({ where: { id: input.ticketId } });
      if (!t || t.guildId !== input.guildId) throw new RpcError('NOT_FOUND', 'Ticket nicht gefunden.');
      return serializeTicket(await claimTicket(ctx, input.ticketId, input.assigneeId));
    },
    async 'tickets.priority'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, ticketId: z.number().int(), priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']), actorId: snowflake }), p);
      const t = await prisma.ticket.findUnique({ where: { id: input.ticketId } });
      if (!t || t.guildId !== input.guildId) throw new RpcError('NOT_FOUND', 'Ticket nicht gefunden.');
      return serializeTicket(await setPriority(ctx, input.ticketId, input.priority, input.actorId));
    },
    async 'tickets.messages'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, ticketId: z.number().int() }), p);
      const t = await prisma.ticket.findUnique({ where: { id: input.ticketId } });
      if (!t || t.guildId !== input.guildId || !t.channelId) throw new RpcError('NOT_FOUND', 'Ticket nicht gefunden.');
      const guild = getGuild(ctx, t.guildId);
      const channel = guild.channels.cache.get(t.channelId) as TextChannel | undefined;
      if (!channel) return [];
      const msgs = await fetchAllMessages(channel, 500);
      return msgs.map((m) => ({
        id: m.id,
        authorId: m.author.id,
        authorTag: m.author.username,
        authorBot: m.author.bot,
        content: m.content || (m.embeds[0]?.description ?? m.embeds[0]?.title ?? ''),
        createdAt: m.createdAt.toISOString(),
        attachments: m.attachments.map((a) => ({ name: a.name, url: a.url })),
      }));
    },
    async 'tickets.reply'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, ticketId: z.number().int(), content: z.string().min(1).max(1800), actorName: z.string().max(64) }), p);
      const t = await prisma.ticket.findUnique({ where: { id: input.ticketId } });
      if (!t || t.guildId !== input.guildId || !t.channelId || t.status === 'CLOSED') throw new RpcError('NOT_FOUND', 'Ticket nicht gefunden oder geschlossen.');
      const guild = getGuild(ctx, t.guildId);
      const channel = await getSendableChannel(guild, t.channelId);
      if (!channel) throw new RpcError('MISSING_PERMISSIONS', 'Der Bot kann in diesem Ticket nicht schreiben.');
      await channel.send({ embeds: [embed(COLORS.brand).setAuthor({ name: `${input.actorName} (Dashboard)` }).setDescription(input.content)] });
      return { ok: true };
    },
  },
};

log.debug('Ticket-Modul geladen');
