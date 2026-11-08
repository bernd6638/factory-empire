import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/prisma';
import { snowflake } from '../../shared/modules';
import { dayStart } from '../../shared/duration';
import { guildAccess } from '../access';
import { apiBus } from '../bus';
import { intParam, pageParams, validate } from '../http';

export const moderationRouter = Router({ mergeParams: true });

const CASE_TYPES = ['WARN', 'TIMEOUT', 'UNTIMEOUT', 'KICK', 'BAN', 'UNBAN', 'NOTE'] as const;

moderationRouter.get('/cases', guildAccess('MODERATOR'), async (req, res) => {
  const guildId = req.guildId!;
  const { limit, page, skip } = pageParams(req.query);
  const f = validate(
    z.object({
      type: z.enum(CASE_TYPES).optional(),
      userId: snowflake.optional(),
      moderatorId: snowflake.optional(),
      source: z.enum(['COMMAND', 'DASHBOARD', 'AUTOMOD', 'SYSTEM']).optional(),
      active: z.enum(['true', 'false']).optional(),
      q: z.string().max(100).optional(),
    }),
    req.query,
  );
  const where: Prisma.ModCaseWhereInput = {
    guildId,
    ...(f.type ? { type: f.type } : {}),
    ...(f.userId ? { userId: f.userId } : {}),
    ...(f.moderatorId ? { moderatorId: f.moderatorId } : {}),
    ...(f.source ? { source: f.source } : {}),
    ...(f.active ? { active: f.active === 'true' } : {}),
    ...(f.q ? { OR: [{ reason: { contains: f.q, mode: 'insensitive' } }, { userTag: { contains: f.q, mode: 'insensitive' } }] } : {}),
  };
  const [items, total] = await Promise.all([prisma.modCase.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip }), prisma.modCase.count({ where })]);
  res.json({ items, total, page, limit });
});

moderationRouter.get('/stats', guildAccess('MODERATOR'), async (req, res) => {
  const guildId = req.guildId!;
  const since = dayStart(new Date(Date.now() - 29 * 86_400_000));
  const [byType, bySource, daily, topModerators, activeWarnings] = await Promise.all([
    prisma.modCase.groupBy({ by: ['type'], where: { guildId, createdAt: { gte: since } }, _count: true }),
    prisma.modCase.groupBy({ by: ['source'], where: { guildId, createdAt: { gte: since } }, _count: true }),
    prisma.$queryRaw<{ day: Date; count: number }[]>`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int AS count FROM "ModCase"
      WHERE "guildId" = ${guildId} AND "createdAt" >= ${since} GROUP BY 1 ORDER BY 1`,
    prisma.modCase.groupBy({ by: ['moderatorId'], where: { guildId, createdAt: { gte: since }, source: { in: ['COMMAND', 'DASHBOARD'] } }, _count: true, orderBy: { _count: { moderatorId: 'desc' } }, take: 5 }),
    prisma.modCase.count({ where: { guildId, type: 'WARN', active: true } }),
  ]);
  const dm = new Map(daily.map((d) => [d.day.toISOString().slice(0, 10), d.count]));
  const series = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    return { date: d, count: dm.get(d) ?? 0 };
  });
  res.json({
    byType: byType.map((b) => ({ type: b.type, count: b._count })),
    bySource: bySource.map((b) => ({ source: b.source, count: b._count })),
    series,
    topModerators: topModerators.map((m) => ({ moderatorId: m.moderatorId, count: m._count })),
    activeWarnings,
  });
});

moderationRouter.post('/actions', guildAccess('MODERATOR'), async (req, res) => {
  const body = validate(
    z.object({
      type: z.enum(CASE_TYPES),
      userId: snowflake,
      reason: z.string().max(500).nullable().optional(),
      durationMinutes: z.number().int().min(1).max(525600).nullable().optional(),
      deleteMessageSeconds: z.number().int().min(0).max(604800).optional(),
    }),
    req.body,
  );
  const result = await apiBus().call('mod.action', { ...body, guildId: req.guildId!, moderatorId: req.session.user!.id }, 20_000);
  res.status(201).json(result);
});

moderationRouter.post('/cases/:caseNumber/revoke', guildAccess('MODERATOR'), async (req, res) => {
  res.json(await apiBus().call('mod.revoke', { guildId: req.guildId!, caseNumber: intParam(req.params.caseNumber, 'caseNumber'), actorId: req.session.user!.id }));
});

moderationRouter.patch('/cases/:caseNumber', guildAccess('MODERATOR'), async (req, res) => {
  const body = validate(z.object({ reason: z.string().max(500) }), req.body);
  const updated = await prisma.modCase.update({
    where: { guildId_caseNumber: { guildId: req.guildId!, caseNumber: intParam(req.params.caseNumber, 'caseNumber') } },
    data: { reason: body.reason },
  });
  res.json(updated);
});

moderationRouter.get('/bans', guildAccess('MODERATOR'), async (req, res) => {
  res.json(await apiBus().call('mod.bans', { guildId: req.guildId! }, 20_000));
});

moderationRouter.get('/raid', guildAccess('MODERATOR'), async (req, res) => {
  res.json(await apiBus().call('automod.raidStatus', { guildId: req.guildId! }));
});

moderationRouter.post('/raid/end', guildAccess('MODERATOR'), async (req, res) => {
  res.json(await apiBus().call('automod.raidEnd', { guildId: req.guildId! }));
});
