import { Router } from 'express';
import { prisma } from '../../shared/prisma';
import { redis } from '../../shared/redis';
import { getBotStatus } from '../../shared/bus';
import { MODULES, MODULE_KEYS } from '../../shared/modules';
import { guildAccess } from '../access';
import { apiBus } from '../bus';

export const controlRouter = Router({ mergeParams: true });

const startedAt = Date.now();

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number }> {
  const t = performance.now();
  try {
    await fn();
    return { ok: true, ms: Math.round(performance.now() - t) };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - t) };
  }
}

interface Warning {
  level: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  link?: string;
}

/** Zentrale Live-Übersicht über alle Module und Systemdienste. */
controlRouter.get('/', guildAccess('VIEWER'), async (req, res) => {
  const guildId = req.guildId!;
  const since24h = new Date(Date.now() - 86_400_000);
  const [bot, db, cache, guild, activeServers, online, openTickets, giveaways, automations, recentRuns, cases24h, modules, moduleErrors, raidTtl] = await Promise.all([
    getBotStatus(),
    timed(() => prisma.$queryRaw`SELECT 1`),
    timed(() => redis().ping()),
    prisma.guild.findUnique({ where: { id: guildId } }),
    prisma.guild.count({ where: { active: true } }),
    redis().get(`dos:online:${guildId}`),
    prisma.ticket.findMany({ where: { guildId, status: { in: ['OPEN', 'CLAIMED'] } }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, number: true, subject: true, priority: true, status: true, createdAt: true, ownerTag: true } }),
    prisma.giveaway.findMany({ where: { guildId, status: { in: ['ACTIVE', 'PAUSED', 'SCHEDULED'] } }, orderBy: { endsAt: 'asc' }, take: 5, include: { _count: { select: { entries: true } } } }),
    prisma.automation.findMany({ where: { guildId }, select: { id: true, name: true, enabled: true, trigger: true, lastRunAt: true, lastError: true, nextRunAt: true, runCount: true } }),
    prisma.automation.findMany({ where: { guildId, lastRunAt: { not: null } }, orderBy: { lastRunAt: 'desc' }, take: 5, select: { id: true, name: true, lastRunAt: true, lastError: true } }),
    prisma.modCase.count({ where: { guildId, createdAt: { gte: since24h } } }),
    prisma.guildModule.findMany({ where: { guildId }, select: { moduleKey: true, enabled: true } }),
    redis().hgetall('dos:module:lasterror'),
    redis().ttl(`dos:raid:${guildId}`),
  ]);

  let live: { botMissing?: string[] } | null = null;
  if (bot?.online) live = await apiBus().call<{ botMissing: string[] }>('guild.info', { guildId }, 5000).catch(() => null);

  const enabled = Object.fromEntries(MODULE_KEYS.map((k) => [k, modules.find((m) => m.moduleKey === k)?.enabled ?? MODULES[k].defaultEnabled]));
  const warnings: Warning[] = [];
  if (!bot?.online) warnings.push({ level: 'critical', title: 'Bot offline', detail: 'Der Discord-Bot sendet keinen Heartbeat. Aktionen und Live-Daten sind nicht verfügbar.' });
  if (!db.ok) warnings.push({ level: 'critical', title: 'Datenbank nicht erreichbar', detail: 'PostgreSQL antwortet nicht.' });
  if (raidTtl > 0) warnings.push({ level: 'critical', title: 'Raid-Sperre aktiv', detail: `Noch ${Math.ceil(raidTtl / 60)} Minuten.`, link: 'moderation' });
  if (live?.botMissing?.length) warnings.push({ level: 'warning', title: 'Fehlende Bot-Berechtigungen', detail: live.botMissing.join(', '), link: 'settings' });
  for (const [key, raw] of Object.entries(moduleErrors)) {
    try {
      const e = JSON.parse(raw) as { message: string; at: number; label: string };
      if (Date.now() - e.at < 86_400_000 && enabled[key as keyof typeof enabled] !== false) {
        warnings.push({ level: 'warning', title: `Fehler im Modul ${MODULES[key as keyof typeof MODULES]?.name ?? key}`, detail: `${e.label}: ${e.message}`, link: 'plugins' });
      }
    } catch {
      /* ignorieren */
    }
  }
  for (const a of automations.filter((x) => x.enabled && x.lastError)) {
    warnings.push({ level: 'info', title: `Automatisierung „${a.name}“ mit Fehler`, detail: a.lastError!, link: 'automations' });
  }

  res.json({
    system: {
      bot,
      backend: { ok: true, uptimeSec: Math.round((Date.now() - startedAt) / 1000), memoryMb: Math.round(process.memoryUsage().rss / 1048576), node: process.version },
      database: db,
      redis: cache,
    },
    activeServers,
    members: guild?.memberCount ?? 0,
    online: online ? Number(online) : null,
    tickets: { open: openTickets.length, latest: openTickets },
    giveaways: giveaways.map((g) => ({ id: g.id, prize: g.prize, status: g.status, endsAt: g.endsAt, startsAt: g.startsAt, entries: g._count.entries })),
    automations: {
      total: automations.length,
      enabled: automations.filter((a) => a.enabled).length,
      next: automations.filter((a) => a.enabled && a.nextRunAt).sort((a, b) => a.nextRunAt!.getTime() - b.nextRunAt!.getTime()).slice(0, 3),
      recent: recentRuns,
    },
    cases24h,
    modules: enabled,
    warnings,
  });
});
