import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../shared/prisma';
import { snowflake } from '../../shared/modules';
import { levelFromXp } from '../../shared/leveling';
import { parseModuleConfig } from '../../shared/modules';
import { dayStart } from '../../shared/duration';
import { guildAccess } from '../access';
import { apiBus } from '../bus';
import { validate } from '../http';
import { userAvatarUrl } from '../discord';

export const membersRouter = Router({ mergeParams: true });

interface LiveMember {
  id: string;
  username: string;
  displayName: string;
  avatar: string;
  bot: boolean;
  joinedAt: string | null;
  roles: string[];
  timedOutUntil: string | null;
}

async function levelConfig(guildId: string) {
  const row = await prisma.guildModule.findUnique({ where: { guildId_moduleKey: { guildId, moduleKey: 'leveling' } } });
  return parseModuleConfig('leveling', row?.config ?? {});
}

/** Mitgliederliste: Live-Daten vom Bot, ergänzt um Statistik aus der Datenbank. */
membersRouter.get('/', guildAccess('VIEWER'), async (req, res) => {
  const q = validate(
    z.object({
      query: z.string().max(100).default(''),
      roleId: snowflake.optional(),
      offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      bots: z.enum(['all', 'humans', 'bots']).default('all'),
    }),
    req.query,
  );
  const guildId = req.guildId!;
  const live = await apiBus().call<{ total: number; cached: number; memberCount: number; items: LiveMember[] }>('guild.members.list', { guildId, ...q });
  const ids = live.items.map((m) => m.id);
  const [profiles, warns] = await Promise.all([
    prisma.memberProfile.findMany({ where: { guildId, userId: { in: ids } } }),
    prisma.modCase.groupBy({ by: ['userId'], where: { guildId, userId: { in: ids }, type: 'WARN', active: true }, _count: true }),
  ]);
  const pm = new Map(profiles.map((p) => [p.userId, p]));
  const wm = new Map(warns.map((w) => [w.userId, w._count]));
  res.json({
    ...live,
    items: live.items.map((m) => ({
      ...m,
      xp: pm.get(m.id)?.xp ?? 0,
      level: pm.get(m.id)?.level ?? 0,
      messages: pm.get(m.id)?.messages ?? 0,
      lastMessageAt: pm.get(m.id)?.lastMessageAt ?? null,
      warnings: wm.get(m.id) ?? 0,
    })),
  });
});

/** Inaktive Mitglieder (aus der Datenbank). */
membersRouter.get('/inactive', guildAccess('VIEWER'), async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const before = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.$queryRaw<{ userId: string; username: string; avatar: string | null; lastMessageAt: Date | null; joinedAt: Date | null; messages: number }[]>`
    SELECT "userId", "username", "avatar", "lastMessageAt", "joinedAt", "messages" FROM "MemberProfile"
    WHERE "guildId" = ${req.guildId!} AND "inGuild" = true AND "bot" = false
      AND COALESCE("lastMessageAt", "joinedAt", "createdAt") < ${before}
    ORDER BY COALESCE("lastMessageAt", "joinedAt", "createdAt") ASC LIMIT 200`;
  res.json(rows.map((r) => ({ ...r, avatarUrl: userAvatarUrl(r.userId, r.avatar) })));
});

/** Benutzerprofil mit Aktivitätsstatistik, Moderationshistorie und Economy-Konto. */
membersRouter.get('/:userId', guildAccess('VIEWER'), async (req, res) => {
  const guildId = req.guildId!;
  const userId = validate(snowflake, req.params.userId);
  const since = dayStart(new Date(Date.now() - 29 * 86_400_000));
  const [live, profile, cases, daily, account, inventory, tickets, cfg] = await Promise.all([
    apiBus().call('guild.member', { guildId, userId }).catch(() => null),
    prisma.memberProfile.findUnique({ where: { guildId_userId: { guildId, userId } } }),
    prisma.modCase.findMany({ where: { guildId, userId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.memberDailyStat.findMany({ where: { guildId, userId, date: { gte: since } }, orderBy: { date: 'asc' } }),
    prisma.economyAccount.findUnique({ where: { guildId_userId: { guildId, userId } }, include: { job: true, company: true } }),
    prisma.inventoryItem.findMany({ where: { guildId, userId }, include: { item: true } }),
    prisma.ticket.count({ where: { guildId, ownerId: userId } }),
    levelConfig(guildId),
  ]);
  const rank = profile ? (await prisma.memberProfile.count({ where: { guildId, bot: false, xp: { gt: profile.xp } } })) + 1 : null;
  const series = [];
  const dm = new Map(daily.map((d) => [d.date.toISOString().slice(0, 10), d]));
  for (let i = 0; i < 30; i++) {
    const d = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    series.push({ date: d, messages: dm.get(d)?.messages ?? 0, xp: dm.get(d)?.xp ?? 0, voiceMinutes: dm.get(d)?.voiceMinutes ?? 0 });
  }
  res.json({
    live,
    profile: profile ? { ...profile, progress: levelFromXp(profile.xp, cfg.curve), rank, avatarUrl: userAvatarUrl(profile.userId, profile.avatar) } : null,
    cases,
    series,
    week: series.slice(-7).reduce((a, d) => ({ messages: a.messages + d.messages, xp: a.xp + d.xp, voiceMinutes: a.voiceMinutes + d.voiceMinutes }), { messages: 0, xp: 0, voiceMinutes: 0 }),
    month: series.reduce((a, d) => ({ messages: a.messages + d.messages, xp: a.xp + d.xp, voiceMinutes: a.voiceMinutes + d.voiceMinutes }), { messages: 0, xp: 0, voiceMinutes: 0 }),
    account,
    inventory,
    tickets,
  });
});

membersRouter.put('/:userId/roles', guildAccess('MODERATOR'), async (req, res) => {
  const body = validate(z.object({ add: z.array(snowflake).max(25).default(() => []), remove: z.array(snowflake).max(25).default(() => []) }), req.body);
  res.json(await apiBus().call('guild.member.roles', { ...body, guildId: req.guildId!, userId: validate(snowflake, req.params.userId), actorId: req.session.user!.id }));
});

membersRouter.post('/:userId/xp', guildAccess('ADMIN'), async (req, res) => {
  const body = validate(z.object({ xp: z.number().int().min(0).max(100_000_000).optional(), level: z.number().int().min(0).max(1000).optional() }).refine((b) => b.xp !== undefined || b.level !== undefined, 'xp oder level angeben'), req.body);
  res.json(await apiBus().call('leveling.setXp', { ...body, guildId: req.guildId!, userId: validate(snowflake, req.params.userId) }));
});
