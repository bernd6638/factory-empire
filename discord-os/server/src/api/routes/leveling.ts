import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../shared/prisma';
import { parseModuleConfig, snowflake } from '../../shared/modules';
import { levelFromXp, totalXpForLevel, xpForNextLevel } from '../../shared/leveling';
import { dayStart } from '../../shared/duration';
import { guildAccess } from '../access';
import { apiBus } from '../bus';
import { validate } from '../http';
import { userAvatarUrl } from '../discord';

export const levelingRouter = Router({ mergeParams: true });

levelingRouter.get('/leaderboard', guildAccess('VIEWER'), async (req, res) => {
  const guildId = req.guildId!;
  const period = validate(z.enum(['all', 'week', 'month']).default('all'), req.query.period);
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const row = await prisma.guildModule.findUnique({ where: { guildId_moduleKey: { guildId, moduleKey: 'leveling' } } });
  const cfg = parseModuleConfig('leveling', row?.config ?? {});

  let items: { userId: string; username: string; avatar: string | null; xp: number; level: number; messages: number; totalXp: number }[];
  if (period === 'all') {
    const rows = await prisma.memberProfile.findMany({ where: { guildId, bot: false, xp: { gt: 0 } }, orderBy: { xp: 'desc' }, take: limit });
    items = rows.map((r) => ({ userId: r.userId, username: r.username, avatar: r.avatar, xp: r.xp, level: r.level, messages: r.messages, totalXp: r.xp }));
  } else {
    const since = dayStart(new Date(Date.now() - (period === 'week' ? 6 : 29) * 86_400_000));
    const rows = await prisma.memberDailyStat.groupBy({ by: ['userId'], where: { guildId, date: { gte: since } }, _sum: { xp: true, messages: true }, orderBy: { _sum: { xp: 'desc' } }, take: limit });
    const profiles = new Map((await prisma.memberProfile.findMany({ where: { guildId, userId: { in: rows.map((r) => r.userId) } } })).map((p) => [p.userId, p]));
    items = rows
      .filter((r) => (r._sum.xp ?? 0) > 0)
      .map((r) => {
        const p = profiles.get(r.userId);
        return { userId: r.userId, username: p?.username ?? r.userId, avatar: p?.avatar ?? null, xp: r._sum.xp ?? 0, level: p?.level ?? 0, messages: r._sum.messages ?? 0, totalXp: p?.xp ?? 0 };
      });
  }
  res.json(items.map((it, idx) => ({ ...it, rank: idx + 1, avatarUrl: userAvatarUrl(it.userId, it.avatar), progress: levelFromXp(it.totalXp, cfg.curve) })));
});

/** Vorschau einer Levelkurve (für den Kurven-Editor im Dashboard). */
levelingRouter.post('/curve-preview', guildAccess('VIEWER'), async (req, res) => {
  const cfg = parseModuleConfig('leveling', { curve: req.body?.curve ?? {} });
  res.json(Array.from({ length: 50 }, (_, l) => ({ level: l + 1, xpForLevel: xpForNextLevel(l, cfg.curve), totalXp: totalXpForLevel(l + 1, cfg.curve) })));
});

levelingRouter.post('/sync-roles', guildAccess('ADMIN'), async (req, res) => {
  res.json(await apiBus().call('leveling.syncRoles', { guildId: req.guildId! }, 60_000));
});

levelingRouter.post('/reset', guildAccess('ADMIN'), async (req, res) => {
  const body = validate(z.object({ userId: snowflake.optional() }), req.body ?? {});
  const where = { guildId: req.guildId!, ...(body.userId ? { userId: body.userId } : {}) };
  const result = await prisma.memberProfile.updateMany({ where, data: { xp: 0, level: 0 } });
  await prisma.memberDailyStat.updateMany({ where, data: { xp: 0 } });
  res.json({ reset: result.count });
});
