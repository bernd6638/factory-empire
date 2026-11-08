import type { NextFunction, Request, Response } from 'express';
import { ZodError, type z } from 'zod';
import { RpcError } from '../shared/bus';
import { childLogger } from '../shared/logger';

const log = childLogger('api');

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'ERROR', public details?: unknown) {
    super(message);
  }
}

const RPC_STATUS: Record<string, number> = {
  BOT_OFFLINE: 503,
  TIMEOUT: 504,
  NOT_FOUND: 404,
  VALIDATION: 400,
  LIMIT: 400,
  INSUFFICIENT_FUNDS: 400,
  INSUFFICIENT_ITEMS: 400,
  OUT_OF_STOCK: 400,
  MISSING_PERMISSIONS: 403,
  HIERARCHY: 403,
  PROTECTED: 403,
  FORBIDDEN: 403,
  DISCORD_ERROR: 502,
  UNKNOWN_METHOD: 501,
};

/** Validiert Eingaben mit Zod und wirft bei Fehlern einen 400er. */
export function validate<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const res = schema.safeParse(data);
  if (!res.success) {
    throw new HttpError(400, res.error.issues.map((i) => `${i.path.join('.') || 'Eingabe'}: ${i.message}`).join('; '), 'VALIDATION', res.error.issues);
  }
  return res.data;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    return;
  }
  if (err instanceof RpcError) {
    const status = RPC_STATUS[err.code] ?? 500;
    if (status >= 500 && err.code !== 'BOT_OFFLINE') log.warn({ code: err.code, msg: err.message, path: req.path }, 'RPC-Fehler');
    res.status(status).json({ error: status === 500 ? 'Interner Fehler im Bot.' : err.message, code: err.code });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Ungültige Eingabe', code: 'VALIDATION', details: err.issues });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Ungültiges JSON', code: 'VALIDATION' });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Anfrage zu groß', code: 'TOO_LARGE' });
    return;
  }
  log.error({ err, path: req.path, method: req.method }, 'Unerwarteter API-Fehler');
  res.status(500).json({ error: 'Interner Serverfehler', code: 'INTERNAL' });
}

export function intParam(v: unknown, name = 'id'): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `Ungültiger Parameter: ${name}`, 'VALIDATION');
  return n;
}

export function pageParams(q: Request['query'], defLimit = 25, maxLimit = 100) {
  const limit = Math.min(Math.max(Number(q.limit) || defLimit, 1), maxLimit);
  const page = Math.max(Number(q.page) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
}

/** JSON-Serialisierung mit BigInt-Unterstützung. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
