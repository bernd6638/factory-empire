import type { NextFunction, Request, Response } from 'express';
import type { Session, SessionData } from 'express-session';
import { prisma } from '../shared/prisma';
import { redis } from '../shared/redis';
import { env } from '../shared/env';
import { ACCESS, PERM, hasPerm, type AccessName } from '../shared/access';
import { userGuilds } from './discord';
import { apiBus } from './bus';
import { HttpError } from './http';

type Sess = Session & Partial<SessionData>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      access?: number;
      guildId?: string;
    }
  }
}

const LEVEL_VALUE = { VIEWER: ACCESS.VIEWER, MODERATOR: ACCESS.MODERATOR, ADMIN: ACCESS.ADMIN } as const;

/** Rollen eines Nutzers auf einem Server (über den Bot, 60 s gecacht). */
async function memberRoles(guildId: string, userId: string): Promise<string[] | null> {
  const key = `dos:memberroles:${guildId}:${userId}`;
  const hit = await redis().get(key);
  if (hit) return JSON.parse(hit) as string[] | null;
  try {
    const res = await apiBus().call<{ roles: string[] } | null>('guild.member.access', { guildId, userId }, 5000);
    const roles = res?.roles ?? null;
    await redis().set(key, JSON.stringify(roles), 'EX', 60);
    return roles;
  } catch {
    return null;
  }
}

/**
 * Ermittelt die Dashboard-Zugriffsstufe eines Nutzers für einen Server:
 *  • Bot-Owner (BOT_OWNER_IDS) und Server-Besitzer → OWNER
 *  • "Administrator" oder "Server verwalten" → ADMIN
 *  • zusätzlich vergebene Dashboard-Rollen/-Nutzer → VIEWER / MODERATOR / ADMIN
 */
export async function resolveAccess(session: Sess, guildId: string): Promise<number> {
  const user = session.user;
  if (!user) return ACCESS.NONE;
  if (env().BOT_OWNER_IDS.includes(user.id)) return ACCESS.OWNER;

  let level: number = ACCESS.NONE;
  const guilds = await userGuilds(session);
  const g = guilds.find((x) => x.id === guildId);
  if (!g) return ACCESS.NONE; // Nutzer ist nicht auf dem Server
  if (g.owner) return ACCESS.OWNER;
  if (hasPerm(g.permissions, PERM.MANAGE_GUILD)) level = ACCESS.ADMIN;

  const grants = await prisma.dashboardPermission.findMany({ where: { guildId } });
  if (grants.length) {
    const userGrant = grants.find((p) => p.targetType === 'USER' && p.targetId === user.id);
    if (userGrant) level = Math.max(level, LEVEL_VALUE[userGrant.level]);
    const roleGrants = grants.filter((p) => p.targetType === 'ROLE');
    if (roleGrants.length && level < ACCESS.ADMIN) {
      const roles = await memberRoles(guildId, user.id);
      for (const rg of roleGrants) if (roles?.includes(rg.targetId)) level = Math.max(level, LEVEL_VALUE[rg.level]);
    }
  }
  return level;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.session.user) return next(new HttpError(401, 'Nicht angemeldet', 'UNAUTHORIZED'));
  next();
}

/** Prüft, ob der Bot auf dem Server ist und der Nutzer mindestens die angegebene Stufe hat. */
export function guildAccess(min: AccessName) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const guildId = String(req.params.guildId ?? '');
      if (!/^\d{15,22}$/.test(guildId)) throw new HttpError(400, 'Ungültige Server-ID', 'VALIDATION');
      if (req.access === undefined || req.guildId !== guildId) {
        const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { active: true } });
        if (!guild?.active) throw new HttpError(404, 'Der Bot ist nicht auf diesem Server.', 'BOT_NOT_IN_GUILD');
        req.access = await resolveAccess(req.session, guildId);
        req.guildId = guildId;
      }
      if (req.access < ACCESS[min]) throw new HttpError(403, 'Keine Berechtigung für diese Aktion.', 'FORBIDDEN');
      next();
    } catch (err) {
      next(err);
    }
  };
}
