import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/prisma';
import { parseModuleConfig, snowflake } from '../../shared/modules';
import { dayStart } from '../../shared/duration';
import { guildAccess } from '../access';
import { HttpError, intParam, pageParams, validate } from '../http';
import { userAvatarUrl } from '../discord';

export const economyRouter = Router({ mergeParams: true });

async function ecoConfig(guildId: string) {
  const row = await prisma.guildModule.findUnique({ where: { guildId_moduleKey: { guildId, moduleKey: 'economy' } } });
  return parseModuleConfig('economy', row?.config ?? {});
}

economyRouter.get('/overview', guildAccess('VIEWER'), async (req, res) => {
  const guildId = req.guildId!;
  const since = dayStart(new Date(Date.now() - 29 * 86_400_000));
  const [sum, accounts, txCount, daily, byType] = await Promise.all([
    prisma.economyAccount.aggregate({ where: { guildId }, _sum: { wallet: true, bank: true } }),
    prisma.economyAccount.count({ where: { guildId } }),
    prisma.transaction.count({ where: { guildId, createdAt: { gte: since } } }),
    prisma.$queryRaw<{ day: Date; volume: number; count: number }[]>`
      SELECT date_trunc('day', "createdAt") AS day, SUM(ABS("amount"))::int AS volume, COUNT(*)::int AS count
      FROM "Transaction" WHERE "guildId" = ${guildId} AND "createdAt" >= ${since} GROUP BY 1 ORDER BY 1`,
    prisma.transaction.groupBy({ by: ['type'], where: { guildId, createdAt: { gte: since } }, _sum: { amount: true }, _count: true }),
  ]);
  const dm = new Map(daily.map((d) => [d.day.toISOString().slice(0, 10), d]));
  res.json({
    config: await ecoConfig(guildId),
    totalWallet: sum._sum.wallet ?? 0,
    totalBank: sum._sum.bank ?? 0,
    accounts,
    transactions30d: txCount,
    series: Array.from({ length: 30 }, (_, i) => {
      const d = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      return { date: d, volume: dm.get(d)?.volume ?? 0, count: dm.get(d)?.count ?? 0 };
    }),
    byType: byType.map((b) => ({ type: b.type, amount: b._sum.amount ?? 0, count: b._count })),
  });
});

economyRouter.get('/accounts', guildAccess('VIEWER'), async (req, res) => {
  const guildId = req.guildId!;
  const { limit, skip, page } = pageParams(req.query, 50);
  const sort = validate(z.enum(['total', 'wallet', 'bank', 'earned']).default('total'), req.query.sort);
  const orderBy = { total: 'total', wallet: '"wallet"', bank: '"bank"', earned: '"totalEarned"' }[sort];
  const rows = await prisma.$queryRawUnsafe<{ userId: string; wallet: number; bank: number; totalEarned: number; total: number; jobId: number | null; companyId: number | null }[]>(
    `SELECT "userId", "wallet", "bank", "totalEarned", ("wallet" + "bank")::int AS total, "jobId", "companyId"
     FROM "EconomyAccount" WHERE "guildId" = $1 ORDER BY ${orderBy} DESC LIMIT $2 OFFSET $3`,
    guildId,
    limit,
    skip,
  );
  const total = await prisma.economyAccount.count({ where: { guildId } });
  const profiles = new Map((await prisma.memberProfile.findMany({ where: { guildId, userId: { in: rows.map((r) => r.userId) } } })).map((p) => [p.userId, p]));
  res.json({
    items: rows.map((r, i) => ({ ...r, rank: skip + i + 1, username: profiles.get(r.userId)?.username ?? r.userId, avatarUrl: userAvatarUrl(r.userId, profiles.get(r.userId)?.avatar ?? null) })),
    total,
    page,
    limit,
  });
});

/** Admin: Kontostand anpassen (wird als ADMIN-Transaktion protokolliert). */
economyRouter.patch('/accounts/:userId', guildAccess('ADMIN'), async (req, res) => {
  const guildId = req.guildId!;
  const userId = validate(snowflake, req.params.userId);
  const body = validate(
    z.object({ walletDelta: z.number().int().min(-100_000_000).max(100_000_000).default(0), bankDelta: z.number().int().min(-100_000_000).max(100_000_000).default(0), note: z.string().max(200).optional() }),
    req.body,
  );
  const cfg = await ecoConfig(guildId);
  const account = await prisma.$transaction(async (tx) => {
    const acc = await tx.economyAccount.upsert({ where: { guildId_userId: { guildId, userId } }, create: { guildId, userId, wallet: cfg.startingBalance }, update: {} });
    if (acc.wallet + body.walletDelta < 0 || acc.bank + body.bankDelta < 0) throw new HttpError(400, 'Der Kontostand darf nicht negativ werden.', 'VALIDATION');
    const updated = await tx.economyAccount.update({ where: { guildId_userId: { guildId, userId } }, data: { wallet: { increment: body.walletDelta }, bank: { increment: body.bankDelta } } });
    await tx.transaction.create({ data: { guildId, type: 'ADMIN', toUserId: userId, amount: body.walletDelta + body.bankDelta, note: body.note ?? `Dashboard-Anpassung durch ${req.session.user!.username}` } });
    return updated;
  });
  res.json(account);
});

economyRouter.get('/transactions', guildAccess('VIEWER'), async (req, res) => {
  const guildId = req.guildId!;
  const { limit, skip, page } = pageParams(req.query, 50);
  const f = validate(z.object({ userId: snowflake.optional(), type: z.string().max(20).optional() }), req.query);
  const where: Prisma.TransactionWhereInput = {
    guildId,
    ...(f.userId ? { OR: [{ fromUserId: f.userId }, { toUserId: f.userId }] } : {}),
    ...(f.type ? { type: f.type as Prisma.TransactionWhereInput['type'] } : {}),
  };
  const [items, total] = await Promise.all([prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip }), prisma.transaction.count({ where })]);
  res.json({ items, total, page, limit });
});

// ── Shop ──
const itemBody = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(200).nullable().optional(),
  emoji: z.string().max(64).nullable().optional(),
  price: z.number().int().min(0).max(100_000_000),
  stock: z.number().int().min(0).max(1_000_000).nullable().optional(),
  roleId: snowflake.nullable().optional(),
  tradable: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

economyRouter.get('/shop', guildAccess('VIEWER'), async (req, res) => {
  const items = await prisma.shopItem.findMany({ where: { guildId: req.guildId! }, orderBy: { price: 'asc' }, include: { _count: { select: { inventory: true } } } });
  res.json(items);
});

economyRouter.post('/shop', guildAccess('ADMIN'), async (req, res) => {
  const body = validate(itemBody, req.body);
  const count = await prisma.shopItem.count({ where: { guildId: req.guildId! } });
  if (count >= 100) throw new HttpError(400, 'Maximal 100 Shop-Artikel pro Server.', 'LIMIT');
  try {
    res.status(201).json(await prisma.shopItem.create({ data: { ...body, guildId: req.guildId! } }));
  } catch {
    throw new HttpError(409, 'Ein Artikel mit diesem Namen existiert bereits.', 'CONFLICT');
  }
});

economyRouter.patch('/shop/:itemId', guildAccess('ADMIN'), async (req, res) => {
  const body = validate(itemBody.partial(), req.body);
  const id = intParam(req.params.itemId);
  const existing = await prisma.shopItem.findFirst({ where: { id, guildId: req.guildId! } });
  if (!existing) throw new HttpError(404, 'Artikel nicht gefunden', 'NOT_FOUND');
  res.json(await prisma.shopItem.update({ where: { id }, data: body }));
});

economyRouter.delete('/shop/:itemId', guildAccess('ADMIN'), async (req, res) => {
  const id = intParam(req.params.itemId);
  const result = await prisma.shopItem.deleteMany({ where: { id, guildId: req.guildId! } });
  if (!result.count) throw new HttpError(404, 'Artikel nicht gefunden', 'NOT_FOUND');
  res.json({ ok: true });
});

// ── Jobs ──
const jobBody = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().max(200).nullable().optional(),
    emoji: z.string().max(64).nullable().optional(),
    minPay: z.number().int().min(0).max(10_000_000),
    maxPay: z.number().int().min(0).max(10_000_000),
    requiredLevel: z.number().int().min(0).max(1000).default(0),
  })
  .refine((j) => j.maxPay >= j.minPay, { message: 'Maximallohn muss ≥ Minimallohn sein', path: ['maxPay'] });

economyRouter.get('/jobs', guildAccess('VIEWER'), async (req, res) => {
  res.json(await prisma.job.findMany({ where: { guildId: req.guildId! }, orderBy: { requiredLevel: 'asc' }, include: { _count: { select: { accounts: true } } } }));
});

economyRouter.post('/jobs', guildAccess('ADMIN'), async (req, res) => {
  const body = validate(jobBody, req.body);
  try {
    res.status(201).json(await prisma.job.create({ data: { ...body, guildId: req.guildId! } }));
  } catch {
    throw new HttpError(409, 'Ein Job mit diesem Namen existiert bereits.', 'CONFLICT');
  }
});

economyRouter.patch('/jobs/:jobId', guildAccess('ADMIN'), async (req, res) => {
  const id = intParam(req.params.jobId);
  const existing = await prisma.job.findFirst({ where: { id, guildId: req.guildId! } });
  if (!existing) throw new HttpError(404, 'Job nicht gefunden', 'NOT_FOUND');
  const body = validate(jobBody, { ...existing, ...req.body });
  res.json(await prisma.job.update({ where: { id }, data: body }));
});

economyRouter.delete('/jobs/:jobId', guildAccess('ADMIN'), async (req, res) => {
  const result = await prisma.job.deleteMany({ where: { id: intParam(req.params.jobId), guildId: req.guildId! } });
  if (!result.count) throw new HttpError(404, 'Job nicht gefunden', 'NOT_FOUND');
  res.json({ ok: true });
});

// ── Firmen ──
economyRouter.get('/companies', guildAccess('VIEWER'), async (req, res) => {
  res.json(await prisma.company.findMany({ where: { guildId: req.guildId! }, orderBy: { balance: 'desc' }, include: { members: { select: { userId: true } } } }));
});

economyRouter.delete('/companies/:companyId', guildAccess('ADMIN'), async (req, res) => {
  const result = await prisma.company.deleteMany({ where: { id: intParam(req.params.companyId), guildId: req.guildId! } });
  if (!result.count) throw new HttpError(404, 'Firma nicht gefunden', 'NOT_FOUND');
  res.json({ ok: true });
});

economyRouter.get('/trades', guildAccess('VIEWER'), async (req, res) => {
  res.json(await prisma.trade.findMany({ where: { guildId: req.guildId! }, orderBy: { createdAt: 'desc' }, take: 50 }));
});
