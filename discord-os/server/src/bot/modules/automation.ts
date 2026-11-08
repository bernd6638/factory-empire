import { Prisma, type Automation } from '@prisma/client';
import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type Guild, type GuildMember, type Message } from 'discord.js';
import { z } from 'zod';
import { prisma } from '../../shared/prisma';
import { renderTemplate } from '../../shared/template';
import { RpcError } from '../../shared/bus';
import { formatDuration, parseDuration } from '../../shared/duration';
import { childLogger } from '../../shared/logger';
import { snowflake } from '../../shared/modules';
import {
  actionSchema,
  conditionsSchema,
  matchesMessage,
  nextCronRun,
  triggerConfigSchemas,
  type AutomationAction,
  type TriggerType,
} from '../../shared/automation';
import type { BotContext, BotModule } from '../core/types';
import { embed, failure, hexToInt, success } from '../utils/embeds';
import { botCanManageRole, getSendableChannel } from '../utils/discord';
import { getGuild, parse } from './core';

const log = childLogger('automation');

/** Regel-Cache pro Server (wird bei Änderungen im Dashboard invalidiert). */
const ruleCache = new Map<string, { rules: Automation[]; at: number }>();
const runCounter = new Map<string, { minute: number; count: number }>();

export function invalidateAutomationCache(guildId: string) {
  ruleCache.delete(guildId);
}

async function rulesFor(guildId: string, trigger: TriggerType): Promise<Automation[]> {
  let entry = ruleCache.get(guildId);
  if (!entry || Date.now() - entry.at > 5 * 60_000) {
    entry = { rules: await prisma.automation.findMany({ where: { guildId, enabled: true } }), at: Date.now() };
    ruleCache.set(guildId, entry);
  }
  return entry.rules.filter((r) => r.trigger === trigger);
}

interface RunContext {
  guild: Guild;
  member?: GuildMember | null;
  userId?: string;
  username?: string;
  channelId?: string | null;
  message?: Message<true> | null;
  extra?: Record<string, string | number>;
}

function passesConditions(rule: Automation, rc: RunContext): boolean {
  const c = conditionsSchema.parse(rule.conditions ?? {});
  const m = rc.member;
  if (!m) return c.requiredRoleIds.length === 0;
  if (c.ignoreBots && m.user.bot) return false;
  if (c.requiredRoleIds.length && !c.requiredRoleIds.some((id) => m.roles.cache.has(id))) return false;
  if (c.excludedRoleIds.some((id) => m.roles.cache.has(id))) return false;
  return true;
}

function allowRun(ruleId: number, maxPerMinute: number): boolean {
  const minute = Math.floor(Date.now() / 60_000);
  const key = String(ruleId);
  const cur = runCounter.get(key);
  if (!cur || cur.minute !== minute) {
    runCounter.set(key, { minute, count: 1 });
    return true;
  }
  if (cur.count >= maxPerMinute) return false;
  cur.count++;
  return true;
}

function vars(rc: RunContext): Record<string, string | number> {
  const userId = rc.member?.id ?? rc.userId;
  return {
    user: userId ? `<@${userId}>` : '',
    username: rc.member?.user.username ?? rc.username ?? '',
    userId: userId ?? '',
    server: rc.guild.name,
    memberCount: rc.guild.memberCount,
    channel: rc.channelId ? `<#${rc.channelId}>` : '',
    date: new Date().toLocaleDateString('de-DE'),
    ...(rc.extra ?? {}),
  };
}

async function runAction(action: AutomationAction, rc: RunContext, ruleName: string) {
  const v = vars(rc);
  const guild = rc.guild;
  switch (action.type) {
    case 'SEND_MESSAGE': {
      const ch = await getSendableChannel(guild, action.channelId ?? rc.channelId);
      if (!ch) throw new Error('Zielkanal nicht verfügbar oder keine Schreibrechte');
      const text = renderTemplate(action.content, v);
      const mentions = { users: rc.member ? [rc.member.id] : [], roles: [] as string[] };
      if (action.embed) await ch.send({ embeds: [embed(hexToInt(action.color)).setDescription(text)], allowedMentions: mentions });
      else await ch.send({ content: text, allowedMentions: mentions });
      break;
    }
    case 'REPLY':
      if (!rc.message) throw new Error('„Antworten“ funktioniert nur bei Nachrichten-Auslösern');
      await rc.message.reply({ content: renderTemplate(action.content, v), allowedMentions: { repliedUser: true, parse: [] } });
      break;
    case 'SEND_DM': {
      const user = rc.member?.user ?? (rc.userId ? await guild.client.users.fetch(rc.userId).catch(() => null) : null);
      if (!user) throw new Error('Kein Mitglied für die Direktnachricht');
      await user.send({ content: renderTemplate(action.content, v) }).catch(() => {
        throw new Error('Direktnachricht konnte nicht zugestellt werden (DMs deaktiviert?)');
      });
      break;
    }
    case 'ADD_ROLE':
    case 'REMOVE_ROLE': {
      if (!rc.member) throw new Error('Keine Mitgliedsinformation für Rollenaktion');
      if (!botCanManageRole(guild, action.roleId)) throw new Error('Der Bot kann diese Rolle nicht verwalten (Hierarchie/Berechtigung)');
      if (action.type === 'ADD_ROLE') await rc.member.roles.add(action.roleId, `Automatisierung: ${ruleName}`);
      else await rc.member.roles.remove(action.roleId, `Automatisierung: ${ruleName}`);
      break;
    }
    case 'ADD_REACTION':
      if (!rc.message) throw new Error('„Reaktion“ funktioniert nur bei Nachrichten-Auslösern');
      await rc.message.react(action.emoji);
      break;
    case 'DELETE_MESSAGE':
      if (!rc.message) throw new Error('„Nachricht löschen“ funktioniert nur bei Nachrichten-Auslösern');
      if (!rc.message.deletable) throw new Error('Der Bot darf diese Nachricht nicht löschen');
      await rc.message.delete();
      break;
    case 'TIMEOUT':
      if (!rc.member) throw new Error('Keine Mitgliedsinformation für Timeout');
      if (!guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers) || !rc.member.moderatable) throw new Error('Der Bot kann dieses Mitglied nicht in den Timeout setzen');
      await rc.member.timeout(action.minutes * 60_000, `Automatisierung: ${ruleName} – ${action.reason}`);
      break;
  }
}

/** Führt eine Regel aus (Bedingungen, Rate-Limit, Aktionen) und speichert das Ergebnis. */
async function execute(ctx: BotContext, rule: Automation, rc: RunContext, opts: { force?: boolean } = {}) {
  if (!opts.force && !passesConditions(rule, rc)) return false;
  const { config } = await ctx.config.get(rc.guild.id, 'automation');
  if (!opts.force && !allowRun(rule.id, config.maxRunsPerMinute)) return false;

  const actions = z.array(actionSchema).safeParse(rule.actions);
  if (!actions.success) {
    await prisma.automation.update({ where: { id: rule.id }, data: { lastError: 'Ungültige Aktionskonfiguration' } }).catch(() => undefined);
    return false;
  }

  const errors: string[] = [];
  for (const action of actions.data) {
    try {
      if (action.delaySeconds > 0) await new Promise((r) => setTimeout(r, action.delaySeconds * 1000));
      await runAction(action, rc, rule.name);
    } catch (err: any) {
      errors.push(`${action.type}: ${err?.message ?? err}`);
    }
  }

  const lastError = errors.length ? errors.join(' | ').slice(0, 1000) : null;
  await prisma.automation
    .update({ where: { id: rule.id }, data: { runCount: { increment: 1 }, lastRunAt: new Date(), lastError } })
    .catch(() => undefined);
  ctx.live(rc.guild.id, 'automation.run', { id: rule.id, name: rule.name, trigger: rule.trigger, userId: rc.member?.id ?? rc.userId ?? null, error: lastError });
  if (errors.length) log.debug({ rule: rule.id, errors }, 'Automatisierung mit Fehlern ausgeführt');
  return true;
}

async function fire(ctx: BotContext, trigger: TriggerType, rc: RunContext, match?: (rule: Automation) => boolean) {
  const rules = await rulesFor(rc.guild.id, trigger);
  for (const rule of rules) {
    if (match && !match(rule)) continue;
    void execute(ctx, rule, rc).catch((err) => log.warn({ err: err?.message, rule: rule.id }, 'Automatisierung fehlgeschlagen'));
  }
}

async function runSchedules(ctx: BotContext) {
  const due = await prisma.automation.findMany({ where: { trigger: 'SCHEDULE', enabled: true, nextRunAt: { lte: new Date() } }, take: 50 });
  for (const rule of due) {
    const guild = ctx.client.guilds.cache.get(rule.guildId);
    const { enabled, config } = guild ? await ctx.config.get(rule.guildId, 'automation') : { enabled: false, config: { timezone: 'UTC' } };
    const cfg = triggerConfigSchemas.SCHEDULE.safeParse(rule.triggerConfig);
    const next = cfg.success ? nextCronRun(cfg.data.cron, config.timezone) : null;
    await prisma.automation.update({ where: { id: rule.id }, data: { nextRunAt: next } });
    if (!guild || !enabled) continue;
    await execute(ctx, rule, { guild, channelId: null });
  }
}

async function runInactivity(ctx: BotContext) {
  const rules = await prisma.automation.findMany({ where: { trigger: 'INACTIVITY', enabled: true } });
  for (const rule of rules) {
    const guild = ctx.client.guilds.cache.get(rule.guildId);
    if (!guild || !(await ctx.config.isEnabled(guild.id, 'automation'))) continue;
    const cfg = triggerConfigSchemas.INACTIVITY.safeParse(rule.triggerConfig);
    if (!cfg.success) continue;
    const key = `inactivity:${rule.id}`;
    const state = await prisma.moduleData.findUnique({ where: { guildId_moduleKey_key: { guildId: guild.id, moduleKey: 'automation', key } } });
    const lastCheck = state ? new Date((state.value as { checkedAt: string }).checkedAt) : rule.createdAt;
    const now = new Date();
    const dayMs = cfg.data.days * 86_400_000;
    // Mitglieder, deren letzte Aktivität seit der letzten Prüfung die Schwelle überschritten hat
    const from = new Date(lastCheck.getTime() - dayMs);
    const to = new Date(now.getTime() - dayMs);
    const inactive = await prisma.$queryRaw<{ userId: string }[]>`
      SELECT "userId" FROM "MemberProfile"
      WHERE "guildId" = ${guild.id} AND "inGuild" = true AND "bot" = false
        AND COALESCE("lastMessageAt", "joinedAt", "createdAt") > ${from}
        AND COALESCE("lastMessageAt", "joinedAt", "createdAt") <= ${to}
      LIMIT 500`;
    for (const row of inactive) {
      const member = await guild.members.fetch(row.userId).catch(() => null);
      if (!member) continue;
      await execute(ctx, rule, { guild, member, extra: { days: cfg.data.days } }, {});
    }
    await prisma.moduleData.upsert({
      where: { guildId_moduleKey_key: { guildId: guild.id, moduleKey: 'automation', key } },
      create: { guildId: guild.id, moduleKey: 'automation', key, value: { checkedAt: now.toISOString() } as Prisma.InputJsonValue },
      update: { value: { checkedAt: now.toISOString() } as Prisma.InputJsonValue },
    });
  }
}

export const automationModule: BotModule = {
  id: 'automation',

  events: {
    async guildMemberAdd(ctx, member) {
      await fire(ctx, 'MEMBER_JOIN', { guild: member.guild, member });
    },
    async guildMemberRemove(ctx, member) {
      // Mitglied ist bereits weg – Rollenaktionen sind nicht möglich
      await fire(ctx, 'MEMBER_LEAVE', { guild: member.guild, member: null, userId: member.id, username: member.user?.username });
    },
    async messageCreate(ctx, message) {
      if (!message.inGuild() || message.author.id === ctx.client.user.id || message.system || !message.content) return;
      const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
      await fire(ctx, 'MESSAGE_CONTAINS', { guild: message.guild, member, channelId: message.channelId, message }, (rule) => {
        const cfg = triggerConfigSchemas.MESSAGE_CONTAINS.safeParse(rule.triggerConfig);
        if (!cfg.success) return false;
        if (cfg.data.channelIds.length && !cfg.data.channelIds.includes(message.channelId)) return false;
        return matchesMessage(message.content, cfg.data);
      });
    },
    async messageReactionAdd(ctx, reaction, user) {
      if (user.bot) return;
      const r = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
      if (!r || !r.message.guild) return;
      const guild = r.message.guild;
      const member = await guild.members.fetch(user.id).catch(() => null);
      const message = r.message.partial ? await r.message.fetch().catch(() => null) : r.message;
      const emojiKey = r.emoji.id ?? r.emoji.name ?? '';
      await fire(ctx, 'REACTION_ADD', { guild, member, channelId: r.message.channelId, message: (message as Message<true>) ?? null }, (rule) => {
        const cfg = triggerConfigSchemas.REACTION_ADD.safeParse(rule.triggerConfig);
        if (!cfg.success) return false;
        if (cfg.data.messageId && cfg.data.messageId !== r.message.id) return false;
        if (cfg.data.emoji && cfg.data.emoji !== emojiKey && cfg.data.emoji !== r.emoji.toString()) return false;
        return true;
      });
    },
    async guildMemberUpdate(ctx, oldMember, newMember) {
      if (oldMember.partial) return;
      const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
      if (!added.size) return;
      await fire(ctx, 'ROLE_ADDED', { guild: newMember.guild, member: newMember }, (rule) => {
        const cfg = triggerConfigSchemas.ROLE_ADDED.safeParse(rule.triggerConfig);
        return cfg.success && added.has(cfg.data.roleId);
      });
    },
  },

  internal: {
    async levelUp(ctx, p) {
      const guild = ctx.client.guilds.cache.get(p.guildId);
      if (!guild) return;
      const member = await guild.members.fetch(p.userId).catch(() => null);
      await fire(ctx, 'LEVEL_UP', { guild, member, channelId: p.channelId, extra: { level: p.level } }, (rule) => {
        const cfg = triggerConfigSchemas.LEVEL_UP.safeParse(rule.triggerConfig);
        return cfg.success && (cfg.data.level === null || cfg.data.level === p.level);
      });
    },
  },

  jobs: [
    { name: 'schedules', intervalMs: 30_000, initialDelayMs: 10_000, run: runSchedules },
    { name: 'inactivity', intervalMs: 60 * 60_000, initialDelayMs: 2 * 60_000, run: runInactivity },
    {
      name: 'reminders',
      intervalMs: 30_000,
      initialDelayMs: 10_000,
      async run(ctx) {
        const due = await prisma.reminder.findMany({ where: { done: false, remindAt: { lte: new Date() } }, take: 50 });
        for (const r of due) {
          await prisma.reminder.update({ where: { id: r.id }, data: { done: true } });
          const guild = ctx.client.guilds.cache.get(r.guildId);
          const ch = guild ? await getSendableChannel(guild, r.channelId) : null;
          const text = `⏰ <@${r.userId}>, deine Erinnerung: ${r.message}`;
          if (ch) await ch.send({ content: text, allowedMentions: { users: [r.userId] } }).catch(() => undefined);
          else await (await ctx.client.users.fetch(r.userId).catch(() => null))?.send(text).catch(() => undefined);
        }
      },
    },
  ],

  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('remind')
        .setDescription('Erinnerung setzen')
        .addStringOption((o) => o.setName('in').setDescription('z. B. 10m, 2h, 1d').setRequired(true))
        .addStringOption((o) => o.setName('nachricht').setDescription('Woran soll erinnert werden?').setRequired(true).setMaxLength(500))
        .toJSON(),
      async execute(i) {
        const ms = parseDuration(i.options.getString('in', true));
        if (!ms || ms > 365 * 86_400_000) {
          await i.reply({ embeds: [failure('Ungültige Dauer (max. 1 Jahr). Beispiele: `10m`, `2h`, `1d`.')], flags: MessageFlags.Ephemeral });
          return;
        }
        const open = await prisma.reminder.count({ where: { guildId: i.guildId, userId: i.user.id, done: false } });
        if (open >= 25) {
          await i.reply({ embeds: [failure('Du hast bereits 25 offene Erinnerungen.')], flags: MessageFlags.Ephemeral });
          return;
        }
        await prisma.reminder.create({ data: { guildId: i.guildId, userId: i.user.id, channelId: i.channelId, message: i.options.getString('nachricht', true), remindAt: new Date(Date.now() + ms) } });
        await i.reply({ embeds: [success(`Ich erinnere dich in **${formatDuration(ms)}**.`)], flags: MessageFlags.Ephemeral });
      },
    },
  ],

  rpc: {
    async 'automation.test'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, ruleId: z.number().int(), actorId: snowflake, channelId: snowflake.nullable().optional() }), p);
      const guild = getGuild(ctx, input.guildId);
      const rule = await prisma.automation.findUnique({ where: { id: input.ruleId } });
      if (!rule || rule.guildId !== guild.id) throw new RpcError('NOT_FOUND', 'Regel nicht gefunden.');
      const member = await guild.members.fetch(input.actorId).catch(() => null);
      await execute(ctx, rule, { guild, member, channelId: input.channelId ?? null, extra: { level: 5, days: 30 } }, { force: true });
      const updated = await prisma.automation.findUnique({ where: { id: rule.id } });
      return { ok: !updated?.lastError, error: updated?.lastError ?? null };
    },
  },
};
