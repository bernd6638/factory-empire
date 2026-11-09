import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  type GuildMember,
  type GuildTextBasedChannel,
} from 'discord.js';
import type { Giveaway } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../shared/prisma';
import { RpcError } from '../../shared/bus';
import { snowflake, type ModuleConfig } from '../../shared/modules';
import { computeDrawOrder } from '../../shared/giveaway';
import { formatDuration } from '../../shared/duration';
import { renderTemplate } from '../../shared/template';
import { childLogger } from '../../shared/logger';
import type { BotContext, BotModule, ComponentInteraction } from '../core/types';
import { COLORS, embed, failure, hexToInt, success, truncate } from '../utils/embeds';
import { getSendableChannel } from '../utils/discord';
import { getGuild, parse } from './core';

const log = childLogger('giveaways');
type Cfg = ModuleConfig<'giveaways'>;

export function serializeGiveaway(g: Giveaway & { _count?: { entries: number } }, opts: { revealSeed?: boolean } = {}) {
  const { seed, ...rest } = g;
  return {
    ...rest,
    seed: opts.revealSeed || g.status === 'ENDED' ? seed : null,
    entryCount: g._count?.entries,
    startsAt: g.startsAt.toISOString(),
    endsAt: g.endsAt.toISOString(),
    pausedAt: g.pausedAt?.toISOString() ?? null,
    endedAt: g.endedAt?.toISOString() ?? null,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

function ts(d: Date, style: 'R' | 'f' = 'R') {
  return `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;
}

function requirementLines(g: Giveaway): string[] {
  const lines: string[] = [];
  if (g.requiredRoleIds.length) lines.push(`• Rolle: ${g.requiredRoleIds.map((r) => `<@&${r}>`).join(' oder ')}`);
  if (g.minMemberDays) lines.push(`• Mindestens ${g.minMemberDays} Tage auf dem Server`);
  if (g.minAccountDays) lines.push(`• Discord-Konto älter als ${g.minAccountDays} Tage`);
  if (g.requireVerified) lines.push('• Verifiziertes Mitglied (Regeln akzeptiert)');
  if (g.maxEntries) lines.push(`• Max. ${g.maxEntries} Teilnehmer`);
  return lines;
}

function buildMessage(g: Giveaway, entryCount: number, cfg: Cfg) {
  const e = embed(g.status === 'ENDED' || g.status === 'CANCELLED' ? COLORS.muted : hexToInt(g.color)).setTitle(`🎁 ${truncate(g.prize, 240)}`);
  const parts: string[] = [];
  if (g.description) parts.push(g.description, '');
  if (g.status === 'ACTIVE') parts.push(`⏳ Endet ${ts(g.endsAt)} (${ts(g.endsAt, 'f')})`);
  if (g.status === 'PAUSED') parts.push('⏸️ **Pausiert** – Teilnahme vorübergehend nicht möglich');
  if (g.status === 'ENDED') parts.push(g.winners.length ? `🏆 Gewinner: ${g.winners.map((w) => `<@${w}>`).join(', ')}` : '😕 Keine gültigen Teilnehmer – kein Gewinner.');
  if (g.status === 'CANCELLED') parts.push('🚫 Dieses Gewinnspiel wurde abgebrochen.');
  parts.push(`👥 **${entryCount}** Teilnehmer · 🏅 ${g.winnerCount} Gewinner · Veranstaltet von <@${g.hostId}>`);
  const req = requirementLines(g);
  if (req.length) parts.push('', '**Teilnahmebedingungen**', ...req);
  e.setDescription(truncate(parts.join('\n'), 4000));
  if (g.imageUrl) e.setImage(g.imageUrl);
  e.setFooter({ text: g.status === 'ENDED' ? `Gewinnspiel #${g.id} • Seed: ${g.seed}` : `Gewinnspiel #${g.id} • Prüfsumme: ${g.seedHash.slice(0, 16)}…` });
  e.setTimestamp(g.endsAt);

  const button = new ButtonBuilder()
    .setCustomId(`giveaway:join:${g.id}`)
    .setLabel(g.status === 'ACTIVE' ? cfg.buttonLabel || 'Teilnehmen' : g.status === 'PAUSED' ? 'Pausiert' : 'Beendet')
    .setStyle(g.status === 'ACTIVE' ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setDisabled(g.status !== 'ACTIVE');
  if (cfg.buttonEmoji) button.setEmoji(cfg.buttonEmoji);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);
  return { embeds: [e], components: [row] };
}

async function channelOf(ctx: BotContext, g: Giveaway): Promise<GuildTextBasedChannel> {
  const guild = getGuild(ctx, g.guildId);
  const ch = await getSendableChannel(guild, g.channelId);
  if (!ch) throw new RpcError('MISSING_PERMISSIONS', 'Der Bot kann im Gewinnspiel-Kanal nicht schreiben.');
  return ch;
}

async function refreshMessage(ctx: BotContext, g: Giveaway) {
  if (!g.messageId) return;
  const { config } = await ctx.config.get(g.guildId, 'giveaways');
  const count = await prisma.giveawayEntry.count({ where: { giveawayId: g.id } });
  const ch = await channelOf(ctx, g).catch(() => null);
  const msg = ch ? await ch.messages.fetch(g.messageId).catch(() => null) : null;
  await msg?.edit(buildMessage(g, count, config)).catch((err) => log.debug({ err: err?.message }, 'Giveaway-Nachricht nicht aktualisiert'));
}

function emit(ctx: BotContext, g: Giveaway, extra: Record<string, unknown> = {}) {
  ctx.live(g.guildId, 'giveaway.updated', { id: g.id, status: g.status, endsAt: g.endsAt.toISOString(), winners: g.winners, ...extra });
}

/** Veröffentlicht ein Gewinnspiel in Discord (geplant → aktiv). */
export async function publishGiveaway(ctx: BotContext, id: number) {
  const g = await prisma.giveaway.findUnique({ where: { id } });
  if (!g) throw new RpcError('NOT_FOUND', 'Gewinnspiel nicht gefunden.');
  if (g.messageId) return g;
  const { config } = await ctx.config.get(g.guildId, 'giveaways');
  const ch = await channelOf(ctx, g);
  const active = { ...g, status: 'ACTIVE' as const };
  const msg = await ch.send({
    content: config.pingRoleId ? `<@&${config.pingRoleId}>` : undefined,
    ...buildMessage(active, 0, config),
    allowedMentions: { roles: config.pingRoleId ? [config.pingRoleId] : [] },
  });
  const updated = await prisma.giveaway.update({ where: { id }, data: { status: 'ACTIVE', messageId: msg.id } });
  emit(ctx, updated);
  return updated;
}

/** Zieht die Gewinner (manipulationsgeschützt) und verkündet sie. */
export async function endGiveaway(ctx: BotContext, id: number, byUserId?: string) {
  const g = await prisma.giveaway.findUnique({ where: { id }, include: { entries: { select: { userId: true } } } });
  if (!g) throw new RpcError('NOT_FOUND', 'Gewinnspiel nicht gefunden.');
  if (g.status === 'ENDED' || g.status === 'CANCELLED') throw new RpcError('VALIDATION', 'Das Gewinnspiel ist bereits beendet.');
  const guild = getGuild(ctx, g.guildId);
  const { config } = await ctx.config.get(g.guildId, 'giveaways');

  // Reihenfolge über alle Teilnehmer; wer den Server verlassen hat, wird übersprungen
  const order = computeDrawOrder(g.seed, g.entries.map((e) => e.userId));
  const winners: string[] = [];
  const remaining: string[] = [];
  for (const userId of order) {
    if (winners.length < g.winnerCount) {
      const m = await guild.members.fetch(userId).catch(() => null);
      if (m) winners.push(userId);
    } else remaining.push(userId);
  }

  const updated = await prisma.giveaway.update({
    where: { id },
    data: { status: 'ENDED', winners, drawOrder: remaining, endedAt: new Date(), endsAt: g.status === 'ACTIVE' && g.endsAt > new Date() ? new Date() : g.endsAt },
  });
  await refreshMessage(ctx, updated);
  await announce(ctx, updated, winners, config, false);
  emit(ctx, updated, { ended: true });
  await ctx.logs.write({
    guildId: g.guildId,
    category: 'server',
    type: 'giveaway',
    summary: `Gewinnspiel „${g.prize}“ beendet – ${winners.length ? `Gewinner: ${winners.length}` : 'keine Gewinner'} (${order.length} Teilnehmer)`,
    actorId: byUserId ?? null,
    data: { giveawayId: g.id, winners, participants: order.length },
  });
  return updated;
}

async function announce(ctx: BotContext, g: Giveaway, winners: string[], cfg: Cfg, reroll: boolean) {
  const ch = await channelOf(ctx, g).catch(() => null);
  if (!ch) return;
  const mentions = winners.map((w) => `<@${w}>`).join(', ');
  const text = winners.length
    ? `${reroll ? '🔁 Neu gezogen: ' : ''}${renderTemplate(cfg.announceTemplate, { winners: mentions, prize: g.prize })}`
    : `😕 Für **${g.prize}** gab es keine gültigen Teilnehmer.`;
  const reply = g.messageId ? { messageReference: g.messageId, failIfNotExists: false } : undefined;
  await ch.send({ content: `${text}\n-# Fair gezogen: Seed \`${g.seed}\` ergibt den vorab veröffentlichten Hash \`${g.seedHash.slice(0, 16)}…\``, reply, allowedMentions: { users: winners } }).catch(() => undefined);
  if (cfg.dmWinners) {
    const guild = getGuild(ctx, g.guildId);
    for (const w of winners) {
      const user = await ctx.client.users.fetch(w).catch(() => null);
      await user?.send({ embeds: [embed(COLORS.success).setTitle('🎉 Du hast gewonnen!').setDescription(`Du hast **${g.prize}** auf **${guild.name}** gewonnen. Melde dich beim Team!`)] }).catch(() => undefined);
    }
  }
}

/** Ersatzgewinner ziehen (nächste in der festgelegten Reihenfolge). */
export async function rerollGiveaway(ctx: BotContext, id: number, count: number, replaceUserId?: string | null) {
  const g = await prisma.giveaway.findUnique({ where: { id } });
  if (!g || g.status !== 'ENDED') throw new RpcError('VALIDATION', 'Nur beendete Gewinnspiele können neu gezogen werden.');
  const guild = getGuild(ctx, g.guildId);
  const { config } = await ctx.config.get(g.guildId, 'giveaways');
  const pool = [...g.drawOrder];
  const picked: string[] = [];
  while (picked.length < count && pool.length) {
    const next = pool.shift()!;
    if (await guild.members.fetch(next).catch(() => null)) picked.push(next);
  }
  if (!picked.length) throw new RpcError('VALIDATION', 'Keine weiteren Ersatzgewinner verfügbar.');
  const winners = replaceUserId ? [...g.winners.filter((w) => w !== replaceUserId), ...picked] : [...g.winners, ...picked];
  const updated = await prisma.giveaway.update({ where: { id }, data: { winners, drawOrder: pool, rerolls: { increment: 1 } } });
  await refreshMessage(ctx, updated);
  await announce(ctx, updated, picked, config, true);
  emit(ctx, updated, { reroll: picked });
  return updated;
}

/** Prüft die Teilnahmebedingungen für ein Mitglied. Gibt eine Fehlermeldung oder null zurück. */
export function checkEligibility(g: Pick<Giveaway, 'requiredRoleIds' | 'blockedRoleIds' | 'minMemberDays' | 'minAccountDays' | 'requireVerified'>, m: GuildMember, now = Date.now()): string | null {
  if (m.user.bot) return 'Bots können nicht teilnehmen.';
  if (g.blockedRoleIds.some((r) => m.roles.cache.has(r))) return 'Mit einer deiner Rollen ist die Teilnahme ausgeschlossen.';
  if (g.requiredRoleIds.length && !g.requiredRoleIds.some((r) => m.roles.cache.has(r))) return `Du benötigst eine dieser Rollen: ${g.requiredRoleIds.map((r) => `<@&${r}>`).join(', ')}`;
  if (g.minMemberDays && (!m.joinedTimestamp || now - m.joinedTimestamp < g.minMemberDays * 86_400_000)) return `Du musst mindestens ${g.minMemberDays} Tage auf dem Server sein.`;
  if (g.minAccountDays && now - m.user.createdTimestamp < g.minAccountDays * 86_400_000) return `Dein Discord-Konto muss älter als ${g.minAccountDays} Tage sein.`;
  if (g.requireVerified && m.pending) return 'Bitte akzeptiere zuerst die Serverregeln.';
  return null;
}

async function handleComponent(i: ComponentInteraction, args: string[], ctx: BotContext) {
  if (!i.isButton() || args[0] !== 'join') return;
  const id = Number(args[1]);
  const g = Number.isInteger(id) ? await prisma.giveaway.findUnique({ where: { id } }) : null;
  if (!g || g.guildId !== i.guildId) throw new RpcError('NOT_FOUND', 'Gewinnspiel nicht gefunden.');
  if (g.status !== 'ACTIVE') throw new RpcError('VALIDATION', g.status === 'PAUSED' ? 'Das Gewinnspiel ist pausiert.' : 'Das Gewinnspiel ist nicht aktiv.');

  const existing = await prisma.giveawayEntry.findUnique({ where: { giveawayId_userId: { giveawayId: id, userId: i.user.id } } });
  if (existing) {
    await prisma.giveawayEntry.delete({ where: { giveawayId_userId: { giveawayId: id, userId: i.user.id } } });
    await prisma.giveaway.update({ where: { id }, data: { countDirty: true } });
    ctx.live(g.guildId, 'giveaway.entry', { id, userId: i.user.id, joined: false });
    await i.reply({ embeds: [success(`Du nimmst nicht mehr an **${g.prize}** teil.`)], flags: MessageFlags.Ephemeral });
    return;
  }

  const reason = checkEligibility(g, i.member);
  if (reason) {
    await i.reply({ embeds: [failure(reason)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  if (g.maxEntries) {
    const count = await prisma.giveawayEntry.count({ where: { giveawayId: id } });
    if (count >= g.maxEntries) throw new RpcError('LIMIT', 'Die maximale Teilnehmerzahl ist erreicht.');
  }
  await prisma.giveawayEntry.create({ data: { giveawayId: id, userId: i.user.id } }).catch(() => undefined);
  await prisma.giveaway.update({ where: { id }, data: { countDirty: true } });
  ctx.live(g.guildId, 'giveaway.entry', { id, userId: i.user.id, username: i.user.username, joined: true });
  await i.reply({ embeds: [success(`Du nimmst an **${g.prize}** teil – viel Glück! 🍀\nNochmal klicken, um die Teilnahme zurückzuziehen.`)], flags: MessageFlags.Ephemeral });
}

async function tick(ctx: BotContext) {
  const now = new Date();
  // Geplante starten
  for (const g of await prisma.giveaway.findMany({ where: { status: 'SCHEDULED', startsAt: { lte: now } }, take: 20 })) {
    if (!ctx.client.guilds.cache.has(g.guildId) || !(await ctx.config.isEnabled(g.guildId, 'giveaways'))) continue;
    await publishGiveaway(ctx, g.id).catch((err) => log.warn({ err: err?.message, id: g.id }, 'Gewinnspiel konnte nicht gestartet werden'));
  }
  // Fällige beenden
  for (const g of await prisma.giveaway.findMany({ where: { status: 'ACTIVE', endsAt: { lte: now } }, take: 20 })) {
    if (!ctx.client.guilds.cache.has(g.guildId)) continue;
    await endGiveaway(ctx, g.id).catch((err) => log.warn({ err: err?.message, id: g.id }, 'Gewinnspiel konnte nicht beendet werden'));
  }
  // Erinnerungen vor Ende
  const reminders = await prisma.giveaway.findMany({ where: { status: 'ACTIVE', reminderSent: false, reminderMinutes: { gt: 0 } }, take: 50 });
  for (const g of reminders) {
    if (g.endsAt.getTime() - g.reminderMinutes * 60_000 > now.getTime()) continue;
    await prisma.giveaway.update({ where: { id: g.id }, data: { reminderSent: true } });
    if (!ctx.client.guilds.cache.has(g.guildId)) continue;
    const { config } = await ctx.config.get(g.guildId, 'giveaways');
    const ch = await channelOf(ctx, g).catch(() => null);
    const text = renderTemplate(config.reminderTemplate, { time: formatDuration(Math.max(g.endsAt.getTime() - now.getTime(), 60_000)), prize: g.prize });
    await ch?.send({ content: text, reply: g.messageId ? { messageReference: g.messageId, failIfNotExists: false } : undefined, allowedMentions: { parse: [] } }).catch(() => undefined);
  }
  // Teilnehmerzahl in der Nachricht aktualisieren (gebündelt gegen Ratenlimits)
  for (const g of await prisma.giveaway.findMany({ where: { status: 'ACTIVE', countDirty: true }, take: 20 })) {
    await prisma.giveaway.update({ where: { id: g.id }, data: { countDirty: false } });
    if (ctx.client.guilds.cache.has(g.guildId)) await refreshMessage(ctx, g);
  }
}

async function load(guildId: string, id: number) {
  const g = await prisma.giveaway.findUnique({ where: { id } });
  if (!g || g.guildId !== guildId) throw new RpcError('NOT_FOUND', 'Gewinnspiel nicht gefunden.');
  return g;
}

const idInput = z.object({ guildId: snowflake, id: z.number().int(), actorId: snowflake.optional() });

export const giveawaysModule: BotModule = {
  id: 'giveaways',
  components: [{ prefix: 'giveaway', handle: handleComponent }],
  jobs: [{ name: 'giveaway-tick', intervalMs: 15_000, initialDelayMs: 8_000, run: tick }],
  rpc: {
    async 'giveaway.publish'(p, ctx) {
      const input = parse(idInput, p);
      const g = await load(input.guildId, input.id);
      const guild = getGuild(ctx, g.guildId);
      const ch = guild.channels.cache.get(g.channelId);
      if (!ch?.isTextBased()) throw new RpcError('NOT_FOUND', 'Kanal nicht gefunden.');
      if (!ch.permissionsFor(guild.members.me!)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) throw new RpcError('MISSING_PERMISSIONS', 'Der Bot darf in diesem Kanal keine Embeds senden.');
      if (g.startsAt > new Date()) return serializeGiveaway(g);
      return serializeGiveaway(await publishGiveaway(ctx, g.id));
    },
    async 'giveaway.end'(p, ctx) {
      const input = parse(idInput, p);
      await load(input.guildId, input.id);
      return serializeGiveaway(await endGiveaway(ctx, input.id, input.actorId));
    },
    async 'giveaway.pause'(p, ctx) {
      const input = parse(idInput, p);
      const g = await load(input.guildId, input.id);
      if (g.status !== 'ACTIVE') throw new RpcError('VALIDATION', 'Nur aktive Gewinnspiele können pausiert werden.');
      const updated = await prisma.giveaway.update({ where: { id: g.id }, data: { status: 'PAUSED', pausedAt: new Date() } });
      await refreshMessage(ctx, updated);
      emit(ctx, updated);
      return serializeGiveaway(updated);
    },
    async 'giveaway.resume'(p, ctx) {
      const input = parse(idInput, p);
      const g = await load(input.guildId, input.id);
      if (g.status !== 'PAUSED' || !g.pausedAt) throw new RpcError('VALIDATION', 'Das Gewinnspiel ist nicht pausiert.');
      // Pausierte Zeit wird an das Ende angehängt
      const endsAt = new Date(g.endsAt.getTime() + (Date.now() - g.pausedAt.getTime()));
      const updated = await prisma.giveaway.update({ where: { id: g.id }, data: { status: 'ACTIVE', pausedAt: null, endsAt } });
      await refreshMessage(ctx, updated);
      emit(ctx, updated);
      return serializeGiveaway(updated);
    },
    async 'giveaway.extend'(p, ctx) {
      const input = parse(idInput.extend({ minutes: z.number().int().min(1).max(43200) }), p);
      const g = await load(input.guildId, input.id);
      if (!['ACTIVE', 'PAUSED', 'SCHEDULED'].includes(g.status)) throw new RpcError('VALIDATION', 'Beendete Gewinnspiele können nicht verlängert werden.');
      const updated = await prisma.giveaway.update({ where: { id: g.id }, data: { endsAt: new Date(g.endsAt.getTime() + input.minutes * 60_000), reminderSent: false } });
      await refreshMessage(ctx, updated);
      emit(ctx, updated);
      return serializeGiveaway(updated);
    },
    async 'giveaway.cancel'(p, ctx) {
      const input = parse(idInput, p);
      const g = await load(input.guildId, input.id);
      if (g.status === 'ENDED' || g.status === 'CANCELLED') throw new RpcError('VALIDATION', 'Das Gewinnspiel ist bereits beendet.');
      const updated = await prisma.giveaway.update({ where: { id: g.id }, data: { status: 'CANCELLED', endedAt: new Date() } });
      await refreshMessage(ctx, updated);
      emit(ctx, updated);
      return serializeGiveaway(updated);
    },
    async 'giveaway.reroll'(p, ctx) {
      const input = parse(idInput.extend({ count: z.number().int().min(1).max(50).default(1), replaceUserId: snowflake.nullable().optional() }), p);
      await load(input.guildId, input.id);
      return serializeGiveaway(await rerollGiveaway(ctx, input.id, input.count, input.replaceUserId));
    },
    async 'giveaway.refresh'(p, ctx) {
      const input = parse(idInput, p);
      const g = await load(input.guildId, input.id);
      await refreshMessage(ctx, g);
      return { ok: true };
    },
  },
};
