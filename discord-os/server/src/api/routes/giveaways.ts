import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/prisma';
import { snowflake } from '../../shared/modules';
import { computeDrawOrder, createSeed, giveawayInputSchema, hashSeed, ticket } from '../../shared/giveaway';
import { guildAccess } from '../access';
import { apiBus } from '../bus';
import { HttpError, intParam, pageParams, validate } from '../http';
import { userAvatarUrl } from '../discord';

export const giveawaysRouter = Router({ mergeParams: true });

function publicGiveaway<T extends { seed: string; status: string }>(g: T) {
  const { seed, ...rest } = g;
  return { ...rest, seed: g.status === 'ENDED' ? seed : null };
}

async function load(guildId: string, id: number) {
  const g = await prisma.giveaway.findFirst({ where: { id, guildId } });
  if (!g) throw new HttpError(404, 'Gewinnspiel nicht gefunden', 'NOT_FOUND');
  return g;
}

async function names(guildId: string, ids: string[]) {
  const rows = await prisma.memberProfile.findMany({ where: { guildId, userId: { in: ids } }, select: { userId: true, username: true, avatar: true } });
  const map = new Map(rows.map((r) => [r.userId, r]));
  return (id: string) => ({ userId: id, username: map.get(id)?.username ?? id, avatarUrl: userAvatarUrl(id, map.get(id)?.avatar ?? null) });
}

giveawaysRouter.get('/', guildAccess('MODERATOR'), async (req, res) => {
  const view = validate(z.enum(['active', 'scheduled', 'ended', 'archived', 'all']).default('all'), req.query.view);
  const where: Prisma.GiveawayWhereInput = { guildId: req.guildId! };
  if (view === 'active') where.status = { in: ['ACTIVE', 'PAUSED'] };
  if (view === 'scheduled') where.status = 'SCHEDULED';
  if (view === 'ended') Object.assign(where, { status: { in: ['ENDED', 'CANCELLED'] }, archived: false });
  if (view === 'archived') where.archived = true;
  const items = await prisma.giveaway.findMany({ where, orderBy: [{ endsAt: view === 'ended' || view === 'archived' ? 'desc' : 'asc' }], take: 100, include: { _count: { select: { entries: true } } } });
  const lookup = await names(req.guildId!, items.flatMap((g) => g.winners));
  res.json(items.map((g) => ({ ...publicGiveaway(g), entryCount: g._count.entries, winnerProfiles: g.winners.map(lookup) })));
});

giveawaysRouter.get('/stats', guildAccess('MODERATOR'), async (req, res) => {
  const guildId = req.guildId!;
  const [byStatus, totalEntries, unique, top] = await Promise.all([
    prisma.giveaway.groupBy({ by: ['status'], where: { guildId }, _count: true }),
    prisma.giveawayEntry.count({ where: { giveaway: { guildId } } }),
    prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(DISTINCT e."userId")::int AS n FROM "GiveawayEntry" e JOIN "Giveaway" g ON g.id = e."giveawayId" WHERE g."guildId" = ${guildId}`,
    prisma.$queryRaw<{ userId: string; n: number }[]>`SELECT e."userId", COUNT(*)::int AS n FROM "GiveawayEntry" e JOIN "Giveaway" g ON g.id = e."giveawayId" WHERE g."guildId" = ${guildId} GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
  ]);
  const total = byStatus.reduce((a, b) => a + b._count, 0);
  const lookup = await names(guildId, top.map((t) => t.userId));
  res.json({
    total,
    active: byStatus.filter((s) => s.status === 'ACTIVE' || s.status === 'PAUSED').reduce((a, b) => a + b._count, 0),
    scheduled: byStatus.find((s) => s.status === 'SCHEDULED')?._count ?? 0,
    ended: byStatus.find((s) => s.status === 'ENDED')?._count ?? 0,
    totalEntries,
    uniqueParticipants: unique[0]?.n ?? 0,
    avgEntries: total ? Math.round(totalEntries / total) : 0,
    topParticipants: top.map((t) => ({ ...lookup(t.userId), entries: t.n })),
  });
});

giveawaysRouter.get('/:id', guildAccess('MODERATOR'), async (req, res) => {
  const g = await load(req.guildId!, intParam(req.params.id));
  const [count, timeline] = await Promise.all([
    prisma.giveawayEntry.count({ where: { giveawayId: g.id } }),
    prisma.$queryRaw<{ t: Date; n: number }[]>`SELECT date_trunc('hour', "createdAt") AS t, COUNT(*)::int AS n FROM "GiveawayEntry" WHERE "giveawayId" = ${g.id} GROUP BY 1 ORDER BY 1`,
  ]);
  let cum = 0;
  const lookup = await names(req.guildId!, g.winners);
  res.json({
    ...publicGiveaway(g),
    entryCount: count,
    winnerProfiles: g.winners.map(lookup),
    reserveCount: g.drawOrder.length,
    timeline: timeline.map((r) => ({ t: r.t.toISOString(), entries: r.n, total: (cum += r.n) })),
  });
});

giveawaysRouter.get('/:id/entries', guildAccess('MODERATOR'), async (req, res) => {
  const g = await load(req.guildId!, intParam(req.params.id));
  const { limit, skip, page } = pageParams(req.query, 50, 200);
  const [rows, total] = await Promise.all([
    prisma.giveawayEntry.findMany({ where: { giveawayId: g.id }, orderBy: { createdAt: 'desc' }, take: limit, skip }),
    prisma.giveawayEntry.count({ where: { giveawayId: g.id } }),
  ]);
  const lookup = await names(req.guildId!, rows.map((r) => r.userId));
  res.json({ items: rows.map((r) => ({ ...lookup(r.userId), createdAt: r.createdAt, winner: g.winners.includes(r.userId) })), total, page, limit });
});

/** Nachweis der fairen Ziehung: Seed, Hash und reproduzierbare Reihenfolge. */
giveawaysRouter.get('/:id/verify', guildAccess('MODERATOR'), async (req, res) => {
  const g = await load(req.guildId!, intParam(req.params.id));
  if (g.status !== 'ENDED') throw new HttpError(400, 'Der Nachweis ist erst nach dem Ende verfügbar.', 'VALIDATION');
  const entries = await prisma.giveawayEntry.findMany({ where: { giveawayId: g.id }, select: { userId: true } });
  const order = computeDrawOrder(g.seed, entries.map((e) => e.userId));
  res.json({
    seed: g.seed,
    seedHash: g.seedHash,
    hashMatches: hashSeed(g.seed) === g.seedHash,
    method: 'Reihenfolge = Teilnehmer aufsteigend sortiert nach HMAC-SHA256(seed, userId). Die ersten gültigen (noch auf dem Server) sind die Gewinner.',
    order: order.slice(0, 200).map((userId, i) => ({ position: i + 1, userId, ticket: ticket(g.seed, userId), winner: g.winners.includes(userId) })),
  });
});

giveawaysRouter.post('/', guildAccess('MODERATOR'), async (req, res) => {
  const input = validate(giveawayInputSchema, req.body);
  const { seed, seedHash } = createSeed();
  const startsAt = input.startsAt && input.startsAt > new Date() ? input.startsAt : new Date();
  const g = await prisma.giveaway.create({
    data: {
      guildId: req.guildId!,
      channelId: input.channelId,
      prize: input.prize,
      description: input.description || null,
      imageUrl: input.imageUrl || null,
      color: input.color,
      winnerCount: input.winnerCount,
      hostId: req.session.user!.id,
      startsAt,
      endsAt: input.endsAt,
      requiredRoleIds: input.requiredRoleIds,
      blockedRoleIds: input.blockedRoleIds,
      minMemberDays: input.minMemberDays,
      minAccountDays: input.minAccountDays,
      requireVerified: input.requireVerified,
      maxEntries: input.maxEntries ?? null,
      reminderMinutes: input.reminderMinutes,
      seed,
      seedHash,
    },
  });
  try {
    const published = await apiBus().call('giveaway.publish', { guildId: req.guildId, id: g.id }, 20_000);
    res.status(201).json(published);
  } catch (err) {
    // Ohne Veröffentlichung kein verwaistes Gewinnspiel zurücklassen
    await prisma.giveaway.delete({ where: { id: g.id } }).catch(() => undefined);
    throw err;
  }
});

const editSchema = z.object({
  prize: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  imageUrl: z.string().url().max(500).nullable().optional().or(z.literal('').transform(() => null)),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  winnerCount: z.number().int().min(1).max(50).optional(),
  requiredRoleIds: z.array(snowflake).max(20).optional(),
  blockedRoleIds: z.array(snowflake).max(20).optional(),
  minMemberDays: z.number().int().min(0).max(3650).optional(),
  minAccountDays: z.number().int().min(0).max(3650).optional(),
  requireVerified: z.boolean().optional(),
  maxEntries: z.number().int().min(1).max(1_000_000).nullable().optional(),
  reminderMinutes: z.number().int().min(0).max(10080).optional(),
});

giveawaysRouter.patch('/:id', guildAccess('MODERATOR'), async (req, res) => {
  const g = await load(req.guildId!, intParam(req.params.id));
  if (g.status === 'ENDED' || g.status === 'CANCELLED') throw new HttpError(400, 'Beendete Gewinnspiele können nicht bearbeitet werden.', 'VALIDATION');
  const data = validate(editSchema, req.body);
  const updated = await prisma.giveaway.update({ where: { id: g.id }, data });
  await apiBus().call('giveaway.refresh', { guildId: req.guildId, id: g.id }).catch(() => undefined);
  res.json(publicGiveaway(updated));
});

for (const action of ['end', 'pause', 'resume', 'cancel'] as const) {
  giveawaysRouter.post(`/:id/${action}`, guildAccess('MODERATOR'), async (req, res) => {
    const g = await load(req.guildId!, intParam(req.params.id));
    res.json(await apiBus().call(`giveaway.${action}`, { guildId: req.guildId, id: g.id, actorId: req.session.user!.id }, 30_000));
  });
}

giveawaysRouter.post('/:id/extend', guildAccess('MODERATOR'), async (req, res) => {
  const body = validate(z.object({ minutes: z.number().int().min(1).max(43200) }), req.body);
  const g = await load(req.guildId!, intParam(req.params.id));
  res.json(await apiBus().call('giveaway.extend', { guildId: req.guildId, id: g.id, minutes: body.minutes }));
});

giveawaysRouter.post('/:id/reroll', guildAccess('MODERATOR'), async (req, res) => {
  const body = validate(z.object({ count: z.number().int().min(1).max(50).default(1), replaceUserId: snowflake.nullable().optional() }), req.body ?? {});
  const g = await load(req.guildId!, intParam(req.params.id));
  res.json(await apiBus().call('giveaway.reroll', { guildId: req.guildId, id: g.id, ...body }, 30_000));
});

giveawaysRouter.post('/:id/archive', guildAccess('MODERATOR'), async (req, res) => {
  const g = await load(req.guildId!, intParam(req.params.id));
  if (g.status !== 'ENDED' && g.status !== 'CANCELLED') throw new HttpError(400, 'Nur beendete Gewinnspiele können archiviert werden.', 'VALIDATION');
  res.json(publicGiveaway(await prisma.giveaway.update({ where: { id: g.id }, data: { archived: !g.archived } })));
});

giveawaysRouter.delete('/:id', guildAccess('ADMIN'), async (req, res) => {
  const g = await load(req.guildId!, intParam(req.params.id));
  if (g.status === 'ACTIVE' || g.status === 'PAUSED') throw new HttpError(400, 'Laufende Gewinnspiele zuerst beenden oder abbrechen.', 'VALIDATION');
  await prisma.giveaway.delete({ where: { id: g.id } });
  res.json({ ok: true });
});
