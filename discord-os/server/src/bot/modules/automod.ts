import { PermissionFlagsBits, type GuildMember, type Message } from 'discord.js';
import { redis } from '../../shared/redis';
import { childLogger } from '../../shared/logger';
import type { AutoAction, ModuleConfig } from '../../shared/modules';
import type { BotContext, BotModule } from '../core/types';
import { COLORS, embed, truncate } from '../utils/embeds';
import { getSendableChannel } from '../utils/discord';
import { SlidingWindow, capsPercent, compileWordFilter, findForbiddenLinks, findInviteCodes } from '../utils/automodRules';

const log = childLogger('automod');
type AutomodConfig = ModuleConfig<'automod'>;

const messageWindow = new SlidingWindow();
const joinWindow = new SlidingWindow(10_000);
const filterCache = new WeakMap<object, (content: string) => string | null>();
const ownInvites = new Map<string, { codes: Set<string>; at: number }>();

const RULE_LABELS = {
  spam: 'Spam',
  duplicate: 'Wiederholte Nachrichten',
  mentions: 'Massen-Erwähnungen',
  links: 'Unerlaubter Link',
  invites: 'Discord-Einladung',
  badwords: 'Unerlaubtes Wort',
  caps: 'Übermäßige Großschreibung',
} as const;
type Rule = keyof typeof RULE_LABELS;

function isExempt(member: GuildMember | null, cfg: AutomodConfig, channelId: string): boolean {
  if (!member) return true;
  if (member.user.bot) return true;
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
  if (cfg.ignoredChannelIds.includes(channelId)) return true;
  return member.roles.cache.some((r) => cfg.ignoredRoleIds.includes(r.id));
}

async function getOwnInvites(member: GuildMember): Promise<Set<string>> {
  const guild = member.guild;
  const cached = ownInvites.get(guild.id);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.codes;
  const codes = new Set<string>();
  if (guild.vanityURLCode) codes.add(guild.vanityURLCode.toLowerCase());
  if (guild.members.me?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    const invites = await guild.invites.fetch().catch(() => null);
    invites?.forEach((inv) => codes.add(inv.code.toLowerCase()));
  }
  ownInvites.set(guild.id, { codes, at: Date.now() });
  return codes;
}

async function check(message: Message<true>, cfg: AutomodConfig): Promise<{ rule: Rule; action: AutoAction; detail: string } | null> {
  const content = message.content ?? '';
  const member = message.member!;

  if (cfg.invites.enabled && content) {
    const codes = findInviteCodes(content);
    if (codes.length) {
      const own = cfg.invites.allowOwnInvites ? await getOwnInvites(member) : new Set<string>();
      const foreign = codes.filter((c) => !own.has(c));
      if (foreign.length) return { rule: 'invites', action: cfg.invites.action, detail: foreign.join(', ') };
    }
  }

  if (cfg.links.enabled && content) {
    const bad = findForbiddenLinks(content, cfg.links.allowedDomains);
    if (bad.length) return { rule: 'links', action: cfg.links.action, detail: bad.slice(0, 5).join(', ') };
  }

  if (cfg.badwords.enabled && content && (cfg.badwords.words.length || cfg.badwords.regex.length)) {
    let matcher = filterCache.get(cfg.badwords);
    if (!matcher) {
      matcher = compileWordFilter(cfg.badwords.words, cfg.badwords.regex);
      filterCache.set(cfg.badwords, matcher);
    }
    const hit = matcher(content);
    if (hit) return { rule: 'badwords', action: cfg.badwords.action, detail: hit };
  }

  if (cfg.caps.enabled && content.length >= cfg.caps.minLength) {
    const { letters, percent } = capsPercent(content);
    if (letters >= cfg.caps.minLength && percent >= cfg.caps.percent) return { rule: 'caps', action: cfg.caps.action, detail: `${percent}% Großbuchstaben` };
  }

  if (cfg.spam.enabled) {
    const mentions = message.mentions.users.size + message.mentions.roles.size + (message.mentions.everyone ? 1 : 0);
    if (mentions >= cfg.spam.maxMentions) return { rule: 'mentions', action: cfg.spam.action, detail: `${mentions} Erwähnungen` };

    const key = `${message.guildId}:${message.author.id}`;
    const windowMs = cfg.spam.intervalSeconds * 1000;
    const normalized = content.trim().toLowerCase().slice(0, 200);
    const hits = messageWindow.push(key, Math.max(windowMs, 60_000), normalized);
    const recent = hits.filter((h) => Date.now() - h.t <= windowMs);
    if (recent.length >= cfg.spam.maxMessages) {
      messageWindow.clear(key);
      return { rule: 'spam', action: cfg.spam.action, detail: `${recent.length} Nachrichten in ${cfg.spam.intervalSeconds}s` };
    }
    if (normalized.length > 0) {
      const dupes = hits.filter((h) => h.v === normalized).length;
      if (dupes >= cfg.spam.duplicateThreshold) {
        messageWindow.clear(key);
        return { rule: 'duplicate', action: cfg.spam.action, detail: `${dupes}× dieselbe Nachricht` };
      }
    }
  }
  return null;
}

async function enforce(ctx: BotContext, message: Message<true>, cfg: AutomodConfig, rule: Rule, action: AutoAction, detail: string) {
  const reason = `Auto-Moderation: ${RULE_LABELS[rule]} (${truncate(detail, 100)})`;
  const botId = ctx.client.user.id;

  if (action.type === 'delete' || action.deleteMessage) {
    if (message.deletable) await message.delete().catch(() => undefined);
  }

  try {
    if (action.type === 'warn') await ctx.mod.perform({ guildId: message.guildId, type: 'WARN', userId: message.author.id, moderatorId: botId, reason, source: 'AUTOMOD' });
    if (action.type === 'timeout')
      await ctx.mod.perform({ guildId: message.guildId, type: 'TIMEOUT', userId: message.author.id, moderatorId: botId, reason, durationMs: action.durationMinutes * 60_000, source: 'AUTOMOD' });
    if (action.type === 'kick') await ctx.mod.perform({ guildId: message.guildId, type: 'KICK', userId: message.author.id, moderatorId: botId, reason, source: 'AUTOMOD' });
    if (action.type === 'ban') await ctx.mod.perform({ guildId: message.guildId, type: 'BAN', userId: message.author.id, moderatorId: botId, reason, deleteMessageSeconds: 3600, source: 'AUTOMOD' });
  } catch (err: any) {
    log.warn({ err: err?.message, rule }, 'Automod-Aktion fehlgeschlagen');
  }

  // Kurzer Hinweis im Kanal (wird nach 6 Sekunden gelöscht)
  if (message.channel.isSendable()) {
    const notice = await message.channel
      .send({ content: `⚠️ <@${message.author.id}>, deine Nachricht wurde entfernt: **${RULE_LABELS[rule]}**.`, allowedMentions: { users: [message.author.id] } })
      .catch(() => null);
    if (notice) setTimeout(() => void notice.delete().catch(() => undefined), 6000);
  }

  const payload = { rule, label: RULE_LABELS[rule], action: action.type, userId: message.author.id, username: message.author.username, channelId: message.channelId, detail };
  ctx.live(message.guildId, 'automod', payload);
  await ctx.logs.write({
    guildId: message.guildId,
    category: 'moderation',
    type: 'automod',
    toggle: 'moderation',
    summary: `${RULE_LABELS[rule]} von ${message.author.username} in <#${message.channelId}> – Aktion: ${action.type}`,
    actorId: botId,
    targetId: message.author.id,
    channelId: message.channelId,
    data: { ...payload, content: truncate(message.content ?? '', 500) },
    color: COLORS.warning,
    fields: [{ name: 'Inhalt', value: truncate(message.content || '—', 1000) }, { name: 'Details', value: detail }],
  });

  if (cfg.logChannelId) {
    const ch = await getSendableChannel(message.guild, cfg.logChannelId);
    await ch
      ?.send({
        embeds: [
          embed(COLORS.warning)
            .setTitle(`🛡️ ${RULE_LABELS[rule]}`)
            .setDescription(`<@${message.author.id}> in <#${message.channelId}>\n**Aktion:** ${action.type}\n**Details:** ${detail}`)
            .addFields({ name: 'Inhalt', value: truncate(message.content || '—', 1000) }),
        ],
        allowedMentions: { parse: [] },
      })
      .catch(() => undefined);
  }
}

async function onMessage(ctx: BotContext, message: Message) {
  if (!message.inGuild() || message.author.bot || message.system) return;
  const cfg = await ctx.config.ifEnabled(message.guildId, 'automod');
  if (!cfg) return;
  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (isExempt(member, cfg, message.channelId)) return;
  const violation = await check(message, cfg);
  if (violation) await enforce(ctx, message, cfg, violation.rule, violation.action, violation.detail);
}

async function raidAction(ctx: BotContext, member: GuildMember, action: 'timeout' | 'kick' | 'ban', reason: string) {
  const botId = ctx.client.user.id;
  const type = action === 'timeout' ? 'TIMEOUT' : action === 'kick' ? 'KICK' : 'BAN';
  await ctx.mod
    .perform({ guildId: member.guild.id, type, userId: member.id, moderatorId: botId, reason, durationMs: type === 'TIMEOUT' ? 60 * 60_000 : null, source: 'AUTOMOD' })
    .catch((err) => log.debug({ err: err?.message }, 'Raid-Aktion fehlgeschlagen'));
}

export const automodModule: BotModule = {
  id: 'automod',
  events: {
    messageCreate: onMessage,
    async messageUpdate(ctx, oldMessage, newMessage) {
      if (oldMessage.content === newMessage.content) return;
      const full = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
      if (!full) return;
      // Bearbeitungen nicht für Spam zählen – nur Inhaltsregeln prüfen
      if (!full.inGuild() || full.author.bot) return;
      const cfg = await ctx.config.ifEnabled(full.guildId, 'automod');
      if (!cfg) return;
      if (isExempt(full.member, cfg, full.channelId)) return;
      const contentOnly = { ...cfg, spam: { ...cfg.spam, enabled: false } };
      const violation = await check(full, contentOnly);
      if (violation) await enforce(ctx, full, cfg, violation.rule, violation.action, violation.detail);
    },

    async guildMemberAdd(ctx, member) {
      const cfg = await ctx.config.ifEnabled(member.guild.id, 'automod');
      if (!cfg || !cfg.raid.enabled || member.user.bot) return;
      const raid = cfg.raid;
      const r = redis();
      const lockKey = `dos:raid:${member.guild.id}`;

      // Neue Konten
      if (raid.minAccountAgeDays > 0 && raid.newAccountAction !== 'none') {
        const ageDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
        if (ageDays < raid.minAccountAgeDays) {
          await raidAction(ctx, member, raid.newAccountAction, `Anti-Raid: Konto jünger als ${raid.minAccountAgeDays} Tage`);
          return;
        }
      }

      const inLockdown = await r.exists(lockKey);
      if (inLockdown) {
        if (raid.action !== 'alert') await raidAction(ctx, member, raid.action, 'Anti-Raid: Beitritt während Raid-Sperre');
        return;
      }

      const hits = joinWindow.push(member.guild.id, raid.intervalSeconds * 1000, member.id);
      if (hits.length < raid.joinThreshold) return;

      await r.set(lockKey, '1', 'EX', raid.lockdownMinutes * 60);
      joinWindow.clear(member.guild.id);
      const ids = hits.map((h) => h.v);
      log.warn({ guild: member.guild.id, joins: ids.length }, 'Raid erkannt');

      ctx.live(member.guild.id, 'raid', { joins: ids.length, intervalSeconds: raid.intervalSeconds, action: raid.action, lockdownMinutes: raid.lockdownMinutes });
      await ctx.logs.write({
        guildId: member.guild.id,
        category: 'moderation',
        type: 'raid',
        toggle: 'moderation',
        summary: `Raid erkannt: ${ids.length} Beitritte in ${raid.intervalSeconds}s. Sperre für ${raid.lockdownMinutes} Minuten aktiv (Aktion: ${raid.action}).`,
        data: { userIds: ids },
        color: COLORS.danger,
      });

      const alert = await getSendableChannel(member.guild, raid.alertChannelId ?? cfg.logChannelId);
      await alert
        ?.send({
          embeds: [
            embed(COLORS.danger)
              .setTitle('🚨 Raid erkannt')
              .setDescription(`**${ids.length}** Beitritte in **${raid.intervalSeconds} Sekunden**.\nRaid-Sperre aktiv für **${raid.lockdownMinutes} Minuten**.\nAktion: **${raid.action}**`),
          ],
        })
        .catch(() => undefined);

      if (raid.action !== 'alert') {
        for (const id of ids) {
          const m = await member.guild.members.fetch(id).catch(() => null);
          if (m) await raidAction(ctx, m, raid.action, 'Anti-Raid: Teil einer Beitrittswelle');
        }
      }
    },
  },
  jobs: [
    {
      name: 'prune-windows',
      intervalMs: 5 * 60_000,
      async run() {
        messageWindow.prune(120_000);
        joinWindow.prune(600_000);
      },
    },
  ],
  rpc: {
    async 'automod.raidStatus'(p) {
      const ttl = await redis().ttl(`dos:raid:${p.guildId}`);
      return { lockdown: ttl > 0, secondsLeft: Math.max(0, ttl) };
    },
    async 'automod.raidEnd'(p) {
      await redis().del(`dos:raid:${p.guildId}`);
      return { ok: true };
    },
  },
};
