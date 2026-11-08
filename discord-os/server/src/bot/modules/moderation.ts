import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { z } from 'zod';
import type { CaseType } from '@prisma/client';
import { prisma } from '../../shared/prisma';
import { formatDuration, parseDuration } from '../../shared/duration';
import { RpcError } from '../../shared/bus';
import { snowflake } from '../../shared/modules';
import type { BotContext, BotModule } from '../core/types';
import { COLORS, embed, failure, success, truncate } from '../utils/embeds';
import { serializeCase } from '../services/ModerationService';
import { parse } from './core';

async function act(i: ChatInputCommandInteraction<'cached'>, ctx: BotContext, type: CaseType, opts: { durationMs?: number | null; deleteMessageSeconds?: number } = {}) {
  const user = i.options.getUser('mitglied', true);
  const reason = i.options.getString('grund');
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const c = await ctx.mod.perform({
    guildId: i.guildId,
    type,
    userId: user.id,
    moderatorId: i.user.id,
    reason,
    durationMs: opts.durationMs,
    deleteMessageSeconds: opts.deleteMessageSeconds,
    source: 'COMMAND',
    actor: i.member,
  });
  const extra = c.durationSec ? ` für **${formatDuration(c.durationSec * 1000)}**` : '';
  await i.editReply({ embeds: [success(`Fall **#${c.caseNumber}**: ${ctx.mod.caseLabel(type)} für **${user.username}**${extra} ausgeführt.`)] });
}

const userOpt = (b: SlashCommandBuilder, desc = 'Das betroffene Mitglied') => b.addUserOption((o) => o.setName('mitglied').setDescription(desc).setRequired(true));
const reasonOpt = (b: any) => b.addStringOption((o: any) => o.setName('grund').setDescription('Begründung').setMaxLength(500));

export const moderationModule: BotModule = {
  id: 'moderation',

  commands: [
    {
      data: reasonOpt(userOpt(new SlashCommandBuilder().setName('warn').setDescription('Verwarnt ein Mitglied').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers))).toJSON(),
      execute: (i, ctx) => act(i, ctx, 'WARN'),
    },
    {
      data: reasonOpt(
        userOpt(new SlashCommandBuilder().setName('timeout').setDescription('Versetzt ein Mitglied in den Timeout').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)).addStringOption((o) =>
          o.setName('dauer').setDescription('z. B. 10m, 2h, 1d (max. 28d)').setRequired(true),
        ),
      ).toJSON(),
      async execute(i, ctx) {
        const ms = parseDuration(i.options.getString('dauer', true));
        if (!ms) {
          await i.reply({ embeds: [failure('Ungültige Dauer. Beispiele: `10m`, `2h`, `1d`.')], flags: MessageFlags.Ephemeral });
          return;
        }
        await act(i, ctx, 'TIMEOUT', { durationMs: ms });
      },
    },
    {
      data: reasonOpt(userOpt(new SlashCommandBuilder().setName('untimeout').setDescription('Hebt einen Timeout auf').setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers))).toJSON(),
      execute: (i, ctx) => act(i, ctx, 'UNTIMEOUT'),
    },
    {
      data: reasonOpt(userOpt(new SlashCommandBuilder().setName('kick').setDescription('Kickt ein Mitglied').setDefaultMemberPermissions(PermissionFlagsBits.KickMembers))).toJSON(),
      execute: (i, ctx) => act(i, ctx, 'KICK'),
    },
    {
      data: reasonOpt(
        userOpt(new SlashCommandBuilder().setName('ban').setDescription('Bannt einen Benutzer').setDefaultMemberPermissions(PermissionFlagsBits.BanMembers), 'Der zu bannende Benutzer')
          .addStringOption((o) => o.setName('dauer').setDescription('Optional: temporärer Bann, z. B. 7d'))
          .addIntegerOption((o) =>
            o
              .setName('nachrichten_loeschen')
              .setDescription('Nachrichten der letzten … löschen')
              .addChoices({ name: 'Nichts', value: 0 }, { name: '1 Stunde', value: 3600 }, { name: '24 Stunden', value: 86400 }, { name: '7 Tage', value: 604800 }),
          ),
      ).toJSON(),
      async execute(i, ctx) {
        const raw = i.options.getString('dauer');
        const ms = raw ? parseDuration(raw) : null;
        if (raw && !ms) {
          await i.reply({ embeds: [failure('Ungültige Dauer.')], flags: MessageFlags.Ephemeral });
          return;
        }
        await act(i, ctx, 'BAN', { durationMs: ms, deleteMessageSeconds: i.options.getInteger('nachrichten_loeschen') ?? 0 });
      },
    },
    {
      data: reasonOpt(
        new SlashCommandBuilder()
          .setName('unban')
          .setDescription('Hebt einen Bann auf')
          .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
          .addStringOption((o) => o.setName('user_id').setDescription('ID des gebannten Benutzers').setRequired(true)),
      ).toJSON(),
      async execute(i, ctx) {
        const id = i.options.getString('user_id', true).trim();
        if (!/^\d{15,22}$/.test(id)) {
          await i.reply({ embeds: [failure('Ungültige User-ID.')], flags: MessageFlags.Ephemeral });
          return;
        }
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const c = await ctx.mod.perform({ guildId: i.guildId, type: 'UNBAN', userId: id, moderatorId: i.user.id, reason: i.options.getString('grund'), source: 'COMMAND' });
        await i.editReply({ embeds: [success(`Fall **#${c.caseNumber}**: Benutzer \`${id}\` wurde entbannt.`)] });
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('note')
        .setDescription('Interne Notiz zu einem Mitglied hinterlegen')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption((o) => o.setName('mitglied').setDescription('Mitglied').setRequired(true))
        .addStringOption((o) => o.setName('grund').setDescription('Notiz').setRequired(true).setMaxLength(500))
        .toJSON(),
      execute: (i, ctx) => act(i, ctx, 'NOTE'),
    },
    {
      data: new SlashCommandBuilder()
        .setName('warnings')
        .setDescription('Zeigt die Moderationshistorie eines Mitglieds')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption((o) => o.setName('mitglied').setDescription('Mitglied').setRequired(true))
        .toJSON(),
      async execute(i, ctx) {
        const user = i.options.getUser('mitglied', true);
        const cases = await prisma.modCase.findMany({ where: { guildId: i.guildId, userId: user.id }, orderBy: { createdAt: 'desc' }, take: 15 });
        const active = await ctx.mod.activeWarningCount(i.guildId, user.id);
        const e = embed(COLORS.warning)
          .setTitle(`Moderationshistorie: ${user.username}`)
          .setThumbnail(user.displayAvatarURL())
          .setDescription(
            cases.length
              ? cases
                  .map((c) => `${c.active ? '🟠' : '⚪'} **#${c.caseNumber}** ${ctx.mod.caseLabel(c.type)} – <t:${Math.floor(c.createdAt.getTime() / 1000)}:R>\n└ ${truncate(c.reason ?? 'Kein Grund', 100)}`)
                  .join('\n')
              : 'Keine Einträge vorhanden.',
          )
          .setFooter({ text: `Aktive Verwarnungen: ${active}` });
        await i.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('case')
        .setDescription('Zeigt einen Moderationsfall')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addIntegerOption((o) => o.setName('nummer').setDescription('Fallnummer').setRequired(true).setMinValue(1))
        .toJSON(),
      async execute(i, ctx) {
        const c = await prisma.modCase.findUnique({ where: { guildId_caseNumber: { guildId: i.guildId, caseNumber: i.options.getInteger('nummer', true) } } });
        if (!c) {
          await i.reply({ embeds: [failure('Fall nicht gefunden.')], flags: MessageFlags.Ephemeral });
          return;
        }
        const e = embed(COLORS.info)
          .setTitle(`Fall #${c.caseNumber} • ${ctx.mod.caseLabel(c.type)}`)
          .addFields(
            { name: 'Mitglied', value: `<@${c.userId}> (${c.userTag ?? c.userId})`, inline: true },
            { name: 'Moderator', value: `<@${c.moderatorId}>`, inline: true },
            { name: 'Status', value: c.active ? 'Aktiv' : 'Inaktiv', inline: true },
            { name: 'Grund', value: c.reason ?? 'Kein Grund angegeben' },
          )
          .setTimestamp(c.createdAt);
        if (c.durationSec) e.addFields({ name: 'Dauer', value: formatDuration(c.durationSec * 1000), inline: true });
        await i.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Löscht mehrere Nachrichten im Kanal')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addIntegerOption((o) => o.setName('anzahl').setDescription('1–100').setRequired(true).setMinValue(1).setMaxValue(100))
        .addUserOption((o) => o.setName('mitglied').setDescription('Nur Nachrichten dieses Mitglieds'))
        .toJSON(),
      async execute(i, ctx) {
        const ch = i.channel;
        if (!ch || !('bulkDelete' in ch)) {
          await i.reply({ embeds: [failure('In diesem Kanal nicht möglich.')], flags: MessageFlags.Ephemeral });
          return;
        }
        if (!ch.permissionsFor(i.guild.members.me!)?.has(PermissionFlagsBits.ManageMessages)) throw new RpcError('MISSING_PERMISSIONS', 'Dem Bot fehlt die Berechtigung „Nachrichten verwalten“.');
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const amount = i.options.getInteger('anzahl', true);
        const target = i.options.getUser('mitglied');
        const fetched = await ch.messages.fetch({ limit: 100 });
        const toDelete = [...fetched.filter((m) => !target || m.author.id === target.id).values()].slice(0, amount);
        const deleted = await ch.bulkDelete(toDelete, true);
        await ctx.logs.write({
          guildId: i.guildId,
          category: 'moderation',
          type: 'message_bulk_delete',
          toggle: 'moderation',
          summary: `${deleted.size} Nachrichten in #${ch.name} gelöscht${target ? ` (nur ${target.username})` : ''}`,
          actorId: i.user.id,
          channelId: ch.id,
          data: { count: deleted.size },
        });
        await i.editReply({ embeds: [success(`${deleted.size} Nachrichten gelöscht.${deleted.size < toDelete.length ? ' (Nachrichten älter als 14 Tage können nicht gelöscht werden.)' : ''}`)] });
      },
    },
  ],

  jobs: [{ name: 'expire-cases', intervalMs: 60_000, initialDelayMs: 15_000, run: (ctx) => ctx.mod.processExpired() }],

  rpc: {
    async 'mod.action'(p, ctx) {
      const input = parse(
        z.object({
          guildId: snowflake,
          userId: snowflake,
          moderatorId: snowflake,
          type: z.enum(['WARN', 'TIMEOUT', 'UNTIMEOUT', 'KICK', 'BAN', 'UNBAN', 'NOTE']),
          reason: z.string().max(500).nullable().optional(),
          durationMinutes: z.number().int().min(1).max(525600).nullable().optional(),
          deleteMessageSeconds: z.number().int().min(0).max(604800).optional(),
        }),
        p,
      );
      // Hierarchie des ausführenden Dashboard-Nutzers prüfen (falls Mitglied)
      const guild = ctx.client.guilds.cache.get(input.guildId);
      const actor = guild ? await guild.members.fetch(input.moderatorId).catch(() => null) : null;
      const c = await ctx.mod.perform({
        guildId: input.guildId,
        type: input.type,
        userId: input.userId,
        moderatorId: input.moderatorId,
        reason: input.reason ?? null,
        durationMs: input.durationMinutes ? input.durationMinutes * 60_000 : null,
        deleteMessageSeconds: input.deleteMessageSeconds,
        source: 'DASHBOARD',
        actor,
      });
      return serializeCase(c);
    },
    async 'mod.revoke'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, caseNumber: z.number().int().min(1), actorId: snowflake }), p);
      return serializeCase(await ctx.mod.revokeCase(input.guildId, input.caseNumber, input.actorId));
    },
    async 'mod.bans'(p, ctx) {
      const guild = ctx.client.guilds.cache.get(p.guildId);
      if (!guild) throw new RpcError('NOT_FOUND', 'Server nicht gefunden.');
      if (!guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) throw new RpcError('MISSING_PERMISSIONS', 'Dem Bot fehlt die Berechtigung „Mitglieder bannen“.');
      const bans = await guild.bans.fetch({ limit: 1000 });
      return bans.map((b) => ({ id: b.user.id, username: b.user.username, avatar: b.user.displayAvatarURL({ size: 64 }), reason: b.reason }));
    },
  },
};
