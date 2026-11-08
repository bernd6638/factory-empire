import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../shared/prisma';
import { childLogger } from '../shared/logger';

const log = childLogger('audit');
const SENSITIVE = /token|secret|password/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[…]';
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? '[entfernt]' : sanitize(v, depth + 1)]));
  }
  return value;
}

export async function audit(guildId: string | null, userId: string, action: string, details: unknown, ip?: string) {
  try {
    await prisma.auditLog.create({ data: { guildId, userId, action, details: (sanitize(details) ?? {}) as Prisma.InputJsonValue, ip: ip ?? null } });
  } catch (err) {
    log.warn({ err }, 'Audit-Log konnte nicht geschrieben werden');
  }
}

/** Protokolliert jede erfolgreiche ändernde Anfrage (POST/PUT/PATCH/DELETE) im Audit-Log. */
export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.session?.user) return;
    const route = `${req.baseUrl}${req.route?.path ?? ''}`.replace(/^\/api\/guilds\/:guildId/, '').replace(/^\/api\/guilds\/\d+/, '') || req.path;
    void audit(req.guildId ?? (req.params.guildId as string | undefined) ?? null, req.session.user.id, `${req.method} ${route}`, { params: req.params, body: req.body }, req.ip);
  });
  next();
}
