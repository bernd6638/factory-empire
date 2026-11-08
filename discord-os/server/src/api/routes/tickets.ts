import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/prisma';
import { snowflake } from '../../shared/modules';
import { dayStart } from '../../shared/duration';
import { guildAccess } from '../access';
import { apiBus } from '../bus';
import { HttpError, intParam, pageParams, validate } from '../http';

export const ticketsRouter = Router({ mergeParams: true });

ticketsRouter.get('/', guildAccess('MODERATOR'), async (req, res) => {
  const guildId = req.guildId!;
  const { limit, page, skip } = pageParams(req.query);
  const f = validate(
    z.object({
      status: z.enum(['OPEN', 'CLAIMED', 'CLOSED', 'ACTIVE']).optional(),
      priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
      category: z.string().max(32).optional(),
      assigneeId: snowflake.optional(),
      q: z.string().max(100).optional(),
    }),
    req.query,
  );
  const where: Prisma.TicketWhereInput = {
    guildId,
    ...(f.status === 'ACTIVE' ? { status: { in: ['OPEN', 'CLAIMED'] } } : f.status ? { status: f.status } : {}),
    ...(f.priority ? { priority: f.priority } : {}),
    ...(f.category ? { categoryKey: f.category } : {}),
    ...(f.assigneeId ? { assigneeId: f.assigneeId } : {}),
    ...(f.q ? { OR: [{ subject: { contains: f.q, mode: 'insensitive' } }, { ownerTag: { contains: f.q, mode: 'insensitive' } }, ...(Number.isInteger(Number(f.q)) ? [{ number: Number(f.q) }] : [])] } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.ticket.findMany({ where, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: limit, skip, include: { _count: { select: { messages: true } } } }),
    prisma.ticket.count({ where }),
  ]);
  res.json({ items, total, page, limit });
});

ticketsRouter.get('/stats', guildAccess('MODERATOR'), async (req, res) => {
  const guildId = req.guildId!;
  const since = dayStart(new Date(Date.now() - 29 * 86_400_000));
  const [byStatus, byCategory, byPriority, daily, resolution, topSupporters] = await Promise.all([
    prisma.ticket.groupBy({ by: ['status'], where: { guildId }, _count: true }),
    prisma.ticket.groupBy({ by: ['categoryKey'], where: { guildId, createdAt: { gte: since } }, _count: true }),
    prisma.ticket.groupBy({ by: ['priority'], where: { guildId, status: { in: ['OPEN', 'CLAIMED'] } }, _count: true }),
    prisma.$queryRaw<{ day: Date; opened: number }[]>`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::int AS opened FROM "Ticket"
      WHERE "guildId" = ${guildId} AND "createdAt" >= ${since} GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<{ avg_close: number | null; avg_claim: number | null }[]>`
      SELECT AVG(EXTRACT(EPOCH FROM ("closedAt" - "createdAt")))::float AS avg_close,
             AVG(EXTRACT(EPOCH FROM ("claimedAt" - "createdAt")))::float AS avg_claim
      FROM "Ticket" WHERE "guildId" = ${guildId} AND "createdAt" >= ${since}`,
    prisma.ticket.groupBy({ by: ['assigneeId'], where: { guildId, assigneeId: { not: null }, createdAt: { gte: since } }, _count: true, orderBy: { _count: { assigneeId: 'desc' } }, take: 5 }),
  ]);
  const dm = new Map(daily.map((d) => [d.day.toISOString().slice(0, 10), d.opened]));
  res.json({
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count })),
    byCategory: byCategory.map((c) => ({ category: c.categoryKey, count: c._count })),
    byPriority: byPriority.map((p) => ({ priority: p.priority, count: p._count })),
    series: Array.from({ length: 30 }, (_, i) => {
      const d = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      return { date: d, opened: dm.get(d) ?? 0 };
    }),
    avgCloseSeconds: resolution[0]?.avg_close ?? null,
    avgClaimSeconds: resolution[0]?.avg_claim ?? null,
    topSupporters: topSupporters.map((s) => ({ userId: s.assigneeId, count: s._count })),
  });
});

ticketsRouter.get('/:ticketId', guildAccess('MODERATOR'), async (req, res) => {
  const id = intParam(req.params.ticketId, 'ticketId');
  const ticket = await prisma.ticket.findFirst({ where: { id, guildId: req.guildId! } });
  if (!ticket) throw new HttpError(404, 'Ticket nicht gefunden', 'NOT_FOUND');
  let messages: unknown[];
  if (ticket.status !== 'CLOSED' && ticket.channelId) {
    messages = await apiBus().call<unknown[]>('tickets.messages', { guildId: ticket.guildId, ticketId: id }, 20_000).catch(() => []);
  } else {
    messages = await prisma.ticketMessage.findMany({ where: { ticketId: id }, orderBy: { createdAt: 'asc' } });
  }
  res.json({ ticket, messages });
});

ticketsRouter.get('/:ticketId/transcript.txt', guildAccess('MODERATOR'), async (req, res) => {
  const id = intParam(req.params.ticketId, 'ticketId');
  const ticket = await prisma.ticket.findFirst({ where: { id, guildId: req.guildId! } });
  if (!ticket) throw new HttpError(404, 'Ticket nicht gefunden', 'NOT_FOUND');
  const msgs = await prisma.ticketMessage.findMany({ where: { ticketId: id }, orderBy: { createdAt: 'asc' } });
  const text = [
    `Transkript – Ticket #${ticket.number}`,
    `Ersteller: ${ticket.ownerTag ?? ticket.ownerId}`,
    `Kategorie: ${ticket.categoryKey} | Priorität: ${ticket.priority} | Status: ${ticket.status}`,
    `Erstellt: ${ticket.createdAt.toISOString()}${ticket.closedAt ? ` | Geschlossen: ${ticket.closedAt.toISOString()}` : ''}`,
    ''.padEnd(60, '─'),
    ...msgs.map((m) => `[${m.createdAt.toISOString().replace('T', ' ').slice(0, 19)}] ${m.authorTag}: ${m.content}`),
  ].join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ticket-${ticket.number}.txt"`);
  res.send(text);
});

ticketsRouter.post('/panel', guildAccess('ADMIN'), async (req, res) => {
  res.json(await apiBus().call('tickets.panel.send', { guildId: req.guildId! }));
});

ticketsRouter.post('/:ticketId/close', guildAccess('MODERATOR'), async (req, res) => {
  const body = validate(z.object({ reason: z.string().max(300).nullable().optional() }), req.body ?? {});
  res.json(await apiBus().call('tickets.close', { guildId: req.guildId!, ticketId: intParam(req.params.ticketId), actorId: req.session.user!.id, reason: body.reason ?? null }, 60_000));
});

ticketsRouter.post('/:ticketId/assign', guildAccess('MODERATOR'), async (req, res) => {
  const body = validate(z.object({ assigneeId: snowflake.optional() }), req.body ?? {});
  res.json(await apiBus().call('tickets.assign', { guildId: req.guildId!, ticketId: intParam(req.params.ticketId), assigneeId: body.assigneeId ?? req.session.user!.id }));
});

ticketsRouter.post('/:ticketId/priority', guildAccess('MODERATOR'), async (req, res) => {
  const body = validate(z.object({ priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']) }), req.body);
  res.json(await apiBus().call('tickets.priority', { guildId: req.guildId!, ticketId: intParam(req.params.ticketId), priority: body.priority, actorId: req.session.user!.id }));
});

ticketsRouter.post('/:ticketId/reply', guildAccess('MODERATOR'), async (req, res) => {
  const body = validate(z.object({ content: z.string().min(1).max(1800) }), req.body);
  const u = req.session.user!;
  res.json(await apiBus().call('tickets.reply', { guildId: req.guildId!, ticketId: intParam(req.params.ticketId), content: body.content, actorName: u.globalName ?? u.username }));
});

ticketsRouter.delete('/:ticketId', guildAccess('ADMIN'), async (req, res) => {
  const id = intParam(req.params.ticketId);
  const ticket = await prisma.ticket.findFirst({ where: { id, guildId: req.guildId! } });
  if (!ticket) throw new HttpError(404, 'Ticket nicht gefunden', 'NOT_FOUND');
  if (ticket.status !== 'CLOSED') throw new HttpError(400, 'Nur geschlossene Tickets können gelöscht werden.', 'VALIDATION');
  await prisma.ticket.delete({ where: { id } });
  res.json({ ok: true });
});
