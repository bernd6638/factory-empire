import { Router } from 'express';
import { prisma } from '../../shared/prisma';
import { redis } from '../../shared/redis';
import { env } from '../../shared/env';
import { getBotStatus } from '../../shared/bus';
import { ACCESS, PERM, accessName, hasPerm } from '../../shared/access';
import { MODULES, MODULE_KEYS } from '../../shared/modules';
import { dayStart, hourStart } from '../../shared/duration';
import { guildIconUrl, userGuilds } from '../discord';
import { guildAccess, resolveAccess } from '../access';
import { apiBus } from '../bus';
import { inviteUrl } from './auth';
import { jsonSafe } from '../http';

export const guildsRouter = Router();

/** Server-Auswahl: alle Server, die der Nutzer verwalten darf, mit Bot-Status. */
guildsRouter.get('/', async (req, res) => {
  const force = req.query.refresh === '1';
  const guilds = await userGuilds(req.session, force);
  const ids = guilds.map((g) => g.id);
  const [botGuilds, grants] = await Promise.all([
    prisma.guild.findMany({ where: { id: { in: ids }, active: true }, select: { id: true, memberCount: true } }),
    prisma.dashboardPermission.findMany({ where: { guildId: { in: ids } }, select: { guildId: true } }),
  ]);
  const botSet = new Map(botGuilds.map((g) => [g.id, g]));
  const withGrants = new Set(grants.map((g) => g.guildId));
  const owner = env().BOT_OWNER_IDS.includes(req.session.user!.id);

  const result = [];
  for (const g of guilds) {
    let access: number = g.owner ? ACCESS.OWNER : hasPerm(g.permissions, PERM.MANAGE_GUILD) ? ACCESS.ADMIN : ACCESS.NONE;
    if (owner) access = ACCESS.OWNER;
    if (access === ACCESS.NONE && botSet.has(g.id) && withGrants.has(g.id)) access = await resolveAccess(req.session, g.id);
    if (access === ACCESS.NONE) continue;
    result.push({
      id: g.id,
      name: g.name,
      icon: guildIconUrl(g.id, g.icon),
      botPresent: botSet.has(g.id),
      memberCount: botSet.get(g.id)?.memberCount ?? null,
      access: accessName(access),
      inviteUrl: botSet.has(g.id) ? null : inviteUrl(g.id),
    });
  }
  result.sort((a, b) => Number(b.botPresent) - Number(a.botPresent) || a.name.localeCompare(b.name));
  res.json(result);
});

guildsRouter.get('/:guildId', guildAccess('VIEWER'), async (req, res) => {
  const guildId = req.guildId!;
  const db = await prisma.guild.findUnique({ where: { id: guildId } });
  const modules = await prisma.guildModule.findMany({ where: { guildId }, select: { moduleKey: true, enabled: true } });
  const enabled = Object.fromEntries(MODULE_KEYS.map((k) => [k, modules.find((m) => m.moduleKey === k)?.enabled ?? MODULES[k].defaultEnabled]));
  let live: unknown = null;
  try {
    live = await apiBus().call('guild.info', { guildId });
  } catch {
    /* Bot offline – Daten aus der Datenbank verwenden */
  }
  res.json({
    id: guildId,
    name: db?.name,
    icon: guildIconUrl(guildId, db?.icon ?? null),
    memberCount: db?.memberCount ?? 0,
    access: accessName(req.access!),
    modules: enabled,
    live,
  });
});

/** Dashboard-Startseite: Kennzahlen, Diagramme, Aktivität. */
guildsRouter.get('/:guildId/overview', guildAccess('VIEWER'), async (req, res) => {
  const guildId = req.guildId!;
  const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 90);
  const since = dayStart(new Date(Date.now() - (days - 1) * 86_400_000));
  const today = dayStart();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const dayAgo = hourStart(new Date(Date.now() - 23 * 3_600_000));

  const [guild, hourlyRaw, dailyMsgs, dayStats, modCount, modByType, openTickets, recentLogs, topMembers, online, bot] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId } }),
    prisma.guildStatHour.findMany({ where: { guildId, hour: { gte: dayAgo } }, orderBy: { hour: 'asc' } }),
    prisma.$queryRaw<{ day: Date; messages: number; joins: number; leaves: number; mod: number; voice: number }[]>`
      SELECT date_trunc('day', "hour") AS day, SUM("messages")::int AS messages, SUM("joins")::int AS joins, SUM("leaves")::int AS leaves,
             SUM("modActions")::int AS mod, SUM("voiceMinutes")::int AS voice
      FROM "GuildStatHour" WHERE "guildId" = ${guildId} AND "hour" >= ${since}
      GROUP BY 1 ORDER BY 1`,
    prisma.guildStatDay.findMany({ where: { guildId, date: { gte: since } }, orderBy: { date: 'asc' } }),
    prisma.modCase.count({ where: { guildId, createdAt: { gte: weekAgo } } }),
    prisma.modCase.groupBy({ by: ['type'], where: { guildId, createdAt: { gte: since } }, _count: true }),
    prisma.ticket.count({ where: { guildId, status: { in: ['OPEN', 'CLAIMED'] } } }),
    prisma.logEntry.findMany({ where: { guildId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    prisma.memberDailyStat.groupBy({ by: ['userId'], where: { guildId, date: { gte: dayStart(weekAgo) } }, _sum: { messages: true, xp: true }, orderBy: { _sum: { messages: 'desc' } }, take: 5 }),
    redis().get(`dos:online:${guildId}`),
    getBotStatus(),
  ]);

  const byDay = new Map(dailyMsgs.map((d) => [d.day.toISOString().slice(0, 10), d]));
  const snap = new Map(dayStats.map((d) => [d.date.toISOString().slice(0, 10), d]));
  const series = [];
  let lastCount: number | null = null;
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const m = byDay.get(d);
    const s = snap.get(d);
    if (s) lastCount = s.memberCount;
    series.push({ date: d, messages: m?.messages ?? 0, joins: m?.joins ?? 0, leaves: m?.leaves ?? 0, modActions: m?.mod ?? 0, voiceMinutes: m?.voice ?? 0, members: s?.memberCount ?? lastCount, online: s?.onlinePeak ?? null });
  }

  const hourly = [];
  const hourMap = new Map(hourlyRaw.map((h) => [h.hour.getTime(), h]));
  for (let i = 0; i < 24; i++) {
    const h = new Date(dayAgo.getTime() + i * 3_600_000);
    const row = hourMap.get(h.getTime());
    hourly.push({ hour: h.toISOString(), messages: row?.messages ?? 0, joins: row?.joins ?? 0 });
  }

  const todayKey = today.toISOString().slice(0, 10);
  const last7 = series.slice(-7);
  const profiles = await prisma.memberProfile.findMany({ where: { guildId, userId: { in: topMembers.map((t) => t.userId) } } });
  const profileMap = new Map(profiles.map((p) => [p.userId, p]));

  res.json(
    jsonSafe({
      totals: {
        members: guild?.memberCount ?? 0,
        online: online ? Number(online) : null,
        messagesToday: byDay.get(todayKey)?.messages ?? 0,
        messages7d: last7.reduce((a, d) => a + d.messages, 0),
        joins7d: last7.reduce((a, d) => a + d.joins, 0),
        leaves7d: last7.reduce((a, d) => a + d.leaves, 0),
        modActions7d: modCount,
        openTickets,
      },
      series,
      hourly,
      modByType: modByType.map((m) => ({ type: m.type, count: m._count })),
      recentLogs,
      topMembers: topMembers.map((t) => ({
        userId: t.userId,
        username: profileMap.get(t.userId)?.username ?? t.userId,
        avatar: profileMap.get(t.userId)?.avatar ?? null,
        messages: t._sum.messages ?? 0,
        xp: t._sum.xp ?? 0,
      })),
      bot,
    }),
  );
});
