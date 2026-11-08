import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/prisma';
import { LOG_CATEGORIES, snowflake } from '../../shared/modules';
import { guildAccess } from '../access';
import { jsonSafe, validate } from '../http';

export const logsRouter = Router({ mergeParams: true });

const filterSchema = z.object({
  category: z.enum(LOG_CATEGORIES).optional(),
  type: z.string().max(40).optional(),
  userId: snowflake.optional(),
  channelId: snowflake.optional(),
  q: z.string().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  before: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function buildWhere(guildId: string, f: z.infer<typeof filterSchema>): Prisma.LogEntryWhereInput {
  return {
    guildId,
    ...(f.category ? { category: f.category } : {}),
    ...(f.type ? { type: f.type } : {}),
    ...(f.userId ? { OR: [{ actorId: f.userId }, { targetId: f.userId }] } : {}),
    ...(f.channelId ? { channelId: f.channelId } : {}),
    ...(f.q ? { summary: { contains: f.q, mode: 'insensitive' } } : {}),
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
    ...(f.before ? { id: { lt: BigInt(f.before) } } : {}),
  };
}

/** Logs mit Cursor-Pagination (stabile Reihenfolge auch bei neuen Einträgen). */
logsRouter.get('/', guildAccess('MODERATOR'), async (req, res) => {
  const f = validate(filterSchema, req.query);
  const where = buildWhere(req.guildId!, f);
  const items = await prisma.logEntry.findMany({ where, orderBy: { id: 'desc' }, take: f.limit + 1 });
  const hasMore = items.length > f.limit;
  const page = items.slice(0, f.limit);
  res.json(jsonSafe({ items: page, nextCursor: hasMore ? page[page.length - 1]!.id.toString() : null }));
});

logsRouter.get('/stats', guildAccess('MODERATOR'), async (req, res) => {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const rows = await prisma.logEntry.groupBy({ by: ['category'], where: { guildId: req.guildId!, createdAt: { gte: since } }, _count: true });
  res.json(rows.map((r) => ({ category: r.category, count: r._count })));
});

logsRouter.get('/export.csv', guildAccess('ADMIN'), async (req, res) => {
  const f = validate(filterSchema.extend({ limit: z.coerce.number().int().min(1).max(10000).default(5000) }), req.query);
  const items = await prisma.logEntry.findMany({ where: buildWhere(req.guildId!, f), orderBy: { id: 'desc' }, take: f.limit });
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const lines = ['Zeit;Kategorie;Typ;Zusammenfassung;Akteur;Ziel;Kanal', ...items.map((l) => [l.createdAt.toISOString(), l.category, l.type, l.summary, l.actorId, l.targetId, l.channelId].map(esc).join(';'))];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="logs-${req.guildId!}.csv"`);
  res.send(`﻿${lines.join('\n')}`);
});
