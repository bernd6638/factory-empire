import { ChannelType, MessageFlags, SlashCommandBuilder, type Guild, type GuildMember } from 'discord.js';
import { z } from 'zod';
import { prisma } from '../../shared/prisma';
import { levelFromXp, totalXpForLevel } from '../../shared/leveling';
import { renderTemplate } from '../../shared/template';
import { dayStart } from '../../shared/duration';
import { snowflake, type ModuleConfig } from '../../shared/modules';
import { RpcError } from '../../shared/bus';
import type { BotContext, BotModule } from '../core/types';
import { COLORS, embed } from '../utils/embeds';
import { botCanManageRole, getSendableChannel, userSnapshot } from '../utils/discord';
import { credit } from '../services/economy';
import { getGuild, parse } from './core';

type LevelConfig = ModuleConfig<'leveling'>;
const cooldowns = new Map<string, number>();

function multiplierFor(member: GuildMember, channelId: string | null, cfg: LevelConfig): number {
  let roleMul = 1;
  for (const rm of cfg.roleMultipliers) if (member.roles.cache.has(rm.roleId)) roleMul = Math.max(roleMul, rm.multiplier);
  const chMul = channelId ? cfg.channelMultipliers.find((c) => c.channelId === channelId)?.multiplier ?? 1 : 1;
  return cfg.globalMultiplier * roleMul * chMul;
}

function isIgnored(member: GuildMember, channelId: string | null, parentId: string | null, cfg: LevelConfig) {
  if (channelId && (cfg.ignoredChannelIds.includes(channelId) || (parentId && cfg.ignoredChannelIds.includes(parentId)))) return true;
  return member.roles.cache.some((r) => cfg.ignoredRoleIds.includes(r.id));
}

/** Vergibt XP und behandelt Level-Ups (Nachricht, Rollen, Coins, Automatisierungen). */
export async function addXp(ctx: BotContext, member: GuildMember, amount: number, channelId: string | null, cfg: LevelConfig) {
  if (amount <= 0) return;
  const guildId = member.guild.id;
  const profile = await prisma.memberProfile.upsert({
    where: { guildId_userId: { guildId, userId: member.id } },
    create: { guildId, userId: member.id, username: member.user.username, avatar: member.user.avatar, bot: member.user.bot, xp: amount, lastXpAt: new Date(), joinedAt: member.joinedAt },
    update: { xp: { increment: amount }, lastXpAt: new Date(), username: member.user.username, avatar: member.user.avatar },
  });
  ctx.stats.xp(guildId, userSnapshot(member.user), amount);
  const progress = levelFromXp(profile.xp, cfg.curve);
  if (progress.level !== profile.level) {
    await prisma.memberProfile.update({ where: { guildId_userId: { guildId, userId: member.id } }, data: { level: progress.level } });
    if (progress.level > profile.level) await onLevelUp(ctx, member, profile.level, progress.level, channelId, cfg);
  }
}

async function onLevelUp(ctx: BotContext, member: GuildMember, oldLevel: number, newLevel: number, channelId: string | null, cfg: LevelConfig) {
  const guild = member.guild;
  await applyRewardRoles(member, newLevel, cfg);

  // Coin-Belohnungen für jedes erreichte Level
  const coinRewards = cfg.rewards.filter((r) => r.coins > 0 && r.level > oldLevel && r.level <= newLevel);
  if (coinRewards.length) {
    const eco = await ctx.config.ifEnabled(guild.id, 'economy');
    if (eco) {
      for (const r of coinRewards) await credit(guild.id, member.id, r.coins, 'REWARD', eco, `Level ${r.level} erreicht`);
    }
  }

  if (cfg.levelUp.enabled) {
    const target = await getSendableChannel(guild, cfg.levelUp.channelId ?? channelId);
    const text = renderTemplate(cfg.levelUp.message, {
      user: `<@${member.id}>`,
      username: member.user.username,
      userId: member.id,
      level: newLevel,
      server: guild.name,
      memberCount: guild.memberCount,
    });
    await target?.send({ content: text, allowedMentions: { users: [member.id] } }).catch(() => undefined);
  }

  ctx.live(guild.id, 'level.up', { userId: member.id, username: member.user.username, level: newLevel });
  ctx.emitInternal('levelUp', { guildId: guild.id, userId: member.id, level: newLevel, channelId });
}

export async function applyRewardRoles(member: GuildMember, level: number, cfg: LevelConfig) {
  const guild = member.guild;
  const roleRewards = cfg.rewards.filter((r) => r.roleId).sort((a, b) => a.level - b.level);
  if (!roleRewards.length) return;
  const earned = roleRewards.filter((r) => r.level <= level);
  const toAdd = new Set<string>();
  const toRemove = new Set<string>();
  if (cfg.stackRewards) {
    earned.forEach((r) => toAdd.add(r.roleId!));
  } else if (earned.length) {
    const top = earned[earned.length - 1]!;
    toAdd.add(top.roleId!);
    earned.slice(0, -1).forEach((r) => r.roleId !== top.roleId && toRemove.add(r.roleId!));
  }
  // Rollen über dem aktuellen Level entfernen (z. B. nach XP-Reset)
  roleRewards.filter((r) => r.level > level).forEach((r) => !toAdd.has(r.roleId!) && toRemove.add(r.roleId!));

  const add = [...toAdd].filter((id) => !member.roles.cache.has(id) && botCanManageRole(guild, id));
  const remove = [...toRemove].filter((id) => member.roles.cache.has(id) && botCanManageRole(guild, id));
  if (add.length) await member.roles.add(add, 'Level-Belohnung').catch(() => undefined);
  if (remove.length) await member.roles.remove(remove, 'Level-Belohnung').catch(() => undefined);
}

async function leaderboard(guildId: string, period: 'all' | 'week' | 'month', limit: number) {
  if (period === 'all') {
    const rows = await prisma.memberProfile.findMany({ where: { guildId, bot: false, xp: { gt: 0 } }, orderBy: { xp: 'desc' }, take: limit });
    return rows.map((r) => ({ userId: r.userId, username: r.username, avatar: r.avatar, xp: r.xp, level: r.level, messages: r.messages }));
  }
  const since = dayStart(new Date(Date.now() - (period === 'week' ? 7 : 30) * 86_400_000));
  const rows = await prisma.memberDailyStat.groupBy({
    by: ['userId'],
    where: { guildId, date: { gte: since } },
    _sum: { xp: true, messages: true },
    orderBy: { _sum: { xp: 'desc' } },
    take: limit,
  });
  const profiles = await prisma.memberProfile.findMany({ where: { guildId, userId: { in: rows.map((r) => r.userId) } } });
  const byId = new Map(profiles.map((p) => [p.userId, p]));
  return rows
    .filter((r) => (r._sum.xp ?? 0) > 0)
    .map((r) => ({ userId: r.userId, username: byId.get(r.userId)?.username ?? r.userId, avatar: byId.get(r.userId)?.avatar ?? null, xp: r._sum.xp ?? 0, level: byId.get(r.userId)?.level ?? 0, messages: r._sum.messages ?? 0 }));
}

function progressBar(percent: number, size = 14) {
  const filled = Math.round((percent / 100) * size);
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

async function voiceXpTick(ctx: BotContext, guild: Guild) {
  const cfg = await ctx.config.ifEnabled(guild.id, 'leveling');
  if (!cfg || !cfg.voiceXp.enabled || cfg.voiceXp.xpPerMinute <= 0) return;
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) continue;
    if (channel.id === guild.afkChannelId) continue;
    const humans = channel.members.filter((m) => !m.user.bot);
    if (humans.size < 2) continue; // allein im Kanal gibt es keine XP
    for (const m of humans.values()) {
      if (m.voice.selfDeaf || m.voice.serverDeaf) continue;
      if (isIgnored(m, channel.id, channel.parentId, cfg)) continue;
      const amount = Math.round(cfg.voiceXp.xpPerMinute * multiplierFor(m, channel.id, cfg));
      await addXp(ctx, m, amount, null, cfg);
    }
  }
}

export const levelingModule: BotModule = {
  id: 'leveling',

  events: {
    async messageCreate(ctx, message) {
      if (!message.inGuild() || message.author.bot || message.system || !message.member) return;
      const cfg = await ctx.config.ifEnabled(message.guildId, 'leveling');
      if (!cfg) return;
      const parentId = 'parentId' in message.channel ? message.channel.parentId : null;
      if (isIgnored(message.member, message.channelId, parentId, cfg)) return;
      const key = `${message.guildId}:${message.author.id}`;
      const last = cooldowns.get(key) ?? 0;
      if (Date.now() - last < cfg.cooldownSeconds * 1000) return;
      cooldowns.set(key, Date.now());
      const base = Math.floor(Math.random() * (Math.max(cfg.xpMax, cfg.xpMin) - cfg.xpMin + 1)) + cfg.xpMin;
      const amount = Math.round(base * multiplierFor(message.member, message.channelId, cfg));
      await addXp(ctx, message.member, amount, message.channelId, cfg);
    },
  },

  jobs: [
    {
      name: 'voice-xp',
      intervalMs: 60_000,
      initialDelayMs: 60_000,
      async run(ctx) {
        for (const g of ctx.client.guilds.cache.values()) {
          if (g.voiceStates.cache.size === 0) continue;
          await voiceXpTick(ctx, g);
        }
        if (cooldowns.size > 100_000) cooldowns.clear();
      },
    },
  ],

  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('rank')
        .setDescription('Zeigt Level und XP')
        .addUserOption((o) => o.setName('mitglied').setDescription('Anderes Mitglied anzeigen'))
        .toJSON(),
      async execute(i, ctx) {
        const user = i.options.getUser('mitglied') ?? i.user;
        const { config: cfg } = await ctx.config.get(i.guildId, 'leveling');
        const profile = await prisma.memberProfile.findUnique({ where: { guildId_userId: { guildId: i.guildId, userId: user.id } } });
        const xp = profile?.xp ?? 0;
        const p = levelFromXp(xp, cfg.curve);
        const rank = profile ? (await prisma.memberProfile.count({ where: { guildId: i.guildId, bot: false, xp: { gt: xp } } })) + 1 : null;
        const e = embed(COLORS.violet)
          .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
          .setTitle(`Level ${p.level}`)
          .setDescription(`${progressBar(p.percent)} **${Math.floor(p.percent)}%**\n${p.current.toLocaleString('de-DE')} / ${p.needed.toLocaleString('de-DE')} XP bis Level ${p.level + 1}`)
          .addFields(
            { name: 'Rang', value: rank ? `#${rank}` : '—', inline: true },
            { name: 'Gesamt-XP', value: xp.toLocaleString('de-DE'), inline: true },
            { name: 'Nachrichten', value: (profile?.messages ?? 0).toLocaleString('de-DE'), inline: true },
          );
        await i.reply({ embeds: [e] });
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Zeigt die XP-Rangliste')
        .addStringOption((o) => o.setName('zeitraum').setDescription('Zeitraum').addChoices({ name: 'Gesamt', value: 'all' }, { name: 'Diese Woche (7 Tage)', value: 'week' }, { name: 'Dieser Monat (30 Tage)', value: 'month' }))
        .toJSON(),
      async execute(i) {
        const period = (i.options.getString('zeitraum') ?? 'all') as 'all' | 'week' | 'month';
        const rows = await leaderboard(i.guildId, period, 10);
        const medals = ['🥇', '🥈', '🥉'];
        const title = { all: 'Gesamt', week: 'Letzte 7 Tage', month: 'Letzte 30 Tage' }[period];
        const e = embed(COLORS.violet)
          .setTitle(`🏆 Rangliste – ${title}`)
          .setDescription(rows.length ? rows.map((r, idx) => `${medals[idx] ?? `**${idx + 1}.**`} <@${r.userId}> – Level ${r.level} • ${r.xp.toLocaleString('de-DE')} XP`).join('\n') : 'Noch keine Daten.');
        await i.reply({ embeds: [e], allowedMentions: { parse: [] } });
      },
    },
  ],

  rpc: {
    async 'leveling.setXp'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, userId: snowflake, xp: z.number().int().min(0).max(100_000_000).optional(), level: z.number().int().min(0).max(1000).optional() }), p);
      const guild = getGuild(ctx, input.guildId);
      const { config: cfg } = await ctx.config.get(guild.id, 'leveling');
      const xp = input.level !== undefined ? totalXpForLevel(input.level, cfg.curve) : input.xp;
      if (xp === undefined) throw new RpcError('VALIDATION', 'xp oder level angeben');
      const level = levelFromXp(xp, cfg.curve).level;
      const member = await guild.members.fetch(input.userId).catch(() => null);
      await prisma.memberProfile.upsert({
        where: { guildId_userId: { guildId: guild.id, userId: input.userId } },
        create: { guildId: guild.id, userId: input.userId, username: member?.user.username ?? input.userId, avatar: member?.user.avatar ?? null, xp, level },
        update: { xp, level },
      });
      if (member) await applyRewardRoles(member, level, cfg);
      return { xp, level };
    },
    async 'leveling.syncRoles'(p, ctx) {
      const guild = getGuild(ctx, p.guildId);
      const { config: cfg } = await ctx.config.get(guild.id, 'leveling');
      const profiles = await prisma.memberProfile.findMany({ where: { guildId: guild.id, inGuild: true, level: { gt: 0 } }, select: { userId: true, level: true } });
      let updated = 0;
      for (const pr of profiles) {
        const m = guild.members.cache.get(pr.userId);
        if (!m) continue;
        await applyRewardRoles(m, pr.level, cfg);
        updated++;
      }
      return { updated };
    },
    async 'leveling.leaderboard'(p) {
      return leaderboard(p.guildId, p.period ?? 'all', Math.min(Number(p.limit) || 50, 100));
    },
  },
};

export { leaderboard };
