import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../shared/prisma';
import { redis } from '../../shared/redis';
import { snowflake } from '../../shared/modules';
import { ACCESS } from '../../shared/access';
import { guildAccess } from '../access';
import { HttpError, intParam, pageParams, validate } from '../http';

export const settingsRouter = Router({ mergeParams: true });

settingsRouter.get('/permissions', guildAccess('ADMIN'), async (req, res) => {
  res.json(await prisma.dashboardPermission.findMany({ where: { guildId: req.guildId! }, orderBy: { createdAt: 'asc' } }));
});

settingsRouter.post('/permissions', guildAccess('ADMIN'), async (req, res) => {
  const guildId = req.guildId!;
  const body = validate(z.object({ targetType: z.enum(['ROLE', 'USER']), targetId: snowflake, level: z.enum(['VIEWER', 'MODERATOR', 'ADMIN']) }), req.body);
  // Nur Besitzer dürfen weitere Admins ernennen
  if (body.level === 'ADMIN' && req.access! < ACCESS.OWNER) throw new HttpError(403, 'Nur der Server-Besitzer kann Admin-Zugriff vergeben.', 'FORBIDDEN');
  if (body.targetType === 'ROLE' && body.targetId === guildId && body.level !== 'VIEWER') {
    throw new HttpError(400, '@everyone darf höchstens Lesezugriff erhalten.', 'VALIDATION');
  }
  const perm = await prisma.dashboardPermission.upsert({
    where: { guildId_targetType_targetId: { guildId, targetType: body.targetType, targetId: body.targetId } },
    create: { guildId, ...body },
    update: { level: body.level },
  });
  await clearAccessCache(guildId);
  res.status(201).json(perm);
});

settingsRouter.delete('/permissions/:id', guildAccess('ADMIN'), async (req, res) => {
  const guildId = req.guildId!;
  const perm = await prisma.dashboardPermission.findFirst({ where: { id: intParam(req.params.id), guildId } });
  if (!perm) throw new HttpError(404, 'Eintrag nicht gefunden', 'NOT_FOUND');
  if (perm.level === 'ADMIN' && req.access! < ACCESS.OWNER) throw new HttpError(403, 'Nur der Server-Besitzer kann Admin-Zugriff entziehen.', 'FORBIDDEN');
  await prisma.dashboardPermission.delete({ where: { id: perm.id } });
  await clearAccessCache(guildId);
  res.json({ ok: true });
});

settingsRouter.get('/audit', guildAccess('ADMIN'), async (req, res) => {
  const { limit, skip, page } = pageParams(req.query, 50);
  const where = { guildId: req.guildId! };
  const [items, total] = await Promise.all([prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip }), prisma.auditLog.count({ where })]);
  const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(items.map((i) => i.userId))] } } })).map((u) => [u.id, u]));
  res.json({ items: items.map((i) => ({ ...i, username: users.get(i.userId)?.username ?? i.userId })), total, page, limit });
});

async function clearAccessCache(guildId: string) {
  // SCAN statt KEYS, damit Redis nicht blockiert
  let cursor = '0';
  do {
    const [next, keys] = await redis().scan(cursor, 'MATCH', `dos:memberroles:${guildId}:*`, 'COUNT', 200);
    if (keys.length) await redis().del(...keys);
    cursor = next;
  } while (cursor !== '0');
}
