import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../shared/prisma';
import { redis } from '../../shared/redis';
import { MODULES, MODULE_KEYS, isModuleKey, parseModuleConfig, type ModuleKey } from '../../shared/modules';
import { levelFromXp } from '../../shared/leveling';
import { guildAccess } from '../access';
import { apiBus } from '../bus';
import { HttpError, validate } from '../http';

export const modulesRouter = Router({ mergeParams: true });

const ERRORS_KEY = 'dos:module:errors';
const LASTERROR_KEY = 'dos:module:lasterror';

function moduleKey(raw: unknown): ModuleKey {
  const k = String(raw);
  if (!isModuleKey(k)) throw new HttpError(404, 'Unbekanntes Modul', 'NOT_FOUND');
  return k;
}

async function dataStats(guildId: string, key: ModuleKey): Promise<Record<string, number>> {
  switch (key) {
    case 'moderation':
      return { Fälle: await prisma.modCase.count({ where: { guildId } }) };
    case 'logging':
      return { Logeinträge: await prisma.logEntry.count({ where: { guildId } }) };
    case 'leveling':
      return { 'Mitglieder mit XP': await prisma.memberProfile.count({ where: { guildId, xp: { gt: 0 } } }) };
    case 'tickets':
      return { Tickets: await prisma.ticket.count({ where: { guildId } }), Geschlossen: await prisma.ticket.count({ where: { guildId, status: 'CLOSED' } }) };
    case 'economy':
      return {
        Konten: await prisma.economyAccount.count({ where: { guildId } }),
        Transaktionen: await prisma.transaction.count({ where: { guildId } }),
        'Shop-Artikel': await prisma.shopItem.count({ where: { guildId } }),
        Firmen: await prisma.company.count({ where: { guildId } }),
      };
    case 'automation':
      return { Regeln: await prisma.automation.count({ where: { guildId } }), Erinnerungen: await prisma.reminder.count({ where: { guildId, done: false } }) };
    case 'voice':
      return { 'Aktive temporäre Kanäle': await prisma.tempVoiceChannel.count({ where: { guildId } }) };
    default:
      return {};
  }
}

/** Plugin-Übersicht: Status, Einstellungen, Fehlerzähler und Datenmenge jedes Moduls. */
modulesRouter.get('/', guildAccess('VIEWER'), async (req, res) => {
  const guildId = req.guildId!;
  const [rows, errors, lastErrors] = await Promise.all([
    prisma.guildModule.findMany({ where: { guildId } }),
    redis().hgetall(ERRORS_KEY),
    redis().hgetall(LASTERROR_KEY),
  ]);
  const result = await Promise.all(
    MODULE_KEYS.map(async (key) => {
      const row = rows.find((r) => r.moduleKey === key);
      const meta = MODULES[key];
      return {
        key,
        name: meta.name,
        description: meta.description,
        icon: meta.icon,
        category: meta.category,
        enabled: row?.enabled ?? meta.defaultEnabled,
        updatedAt: row?.updatedAt ?? null,
        errors: Number(errors[key] ?? 0),
        lastError: lastErrors[key] ? JSON.parse(lastErrors[key]!) : null,
        data: await dataStats(guildId, key),
      };
    }),
  );
  res.json(result);
});

modulesRouter.get('/:key', guildAccess('VIEWER'), async (req, res) => {
  const guildId = req.guildId!;
  const key = moduleKey(req.params.key);
  const row = await prisma.guildModule.findUnique({ where: { guildId_moduleKey: { guildId, moduleKey: key } } });
  res.json({
    key,
    enabled: row?.enabled ?? MODULES[key].defaultEnabled,
    config: parseModuleConfig(key, row?.config ?? {}),
    defaults: parseModuleConfig(key, {}),
    updatedAt: row?.updatedAt ?? null,
  });
});

/** Leveling: bei geänderter Kurve alle Level neu berechnen. */
async function recalcLevels(guildId: string) {
  const row = await prisma.guildModule.findUnique({ where: { guildId_moduleKey: { guildId, moduleKey: 'leveling' } } });
  const cfg = parseModuleConfig('leveling', row?.config ?? {});
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.memberProfile.findMany({ where: { guildId, xp: { gt: 0 } }, select: { userId: true, xp: true, level: true }, orderBy: { userId: 'asc' }, take: 1000, ...(cursor ? { cursor: { guildId_userId: { guildId, userId: cursor } }, skip: 1 } : {}) });
    if (!batch.length) break;
    const changes = batch.map((p) => ({ ...p, next: levelFromXp(p.xp, cfg.curve).level })).filter((p) => p.next !== p.level);
    if (changes.length) await prisma.$transaction(changes.map((c) => prisma.memberProfile.update({ where: { guildId_userId: { guildId, userId: c.userId } }, data: { level: c.next } })));
    cursor = batch[batch.length - 1]!.userId;
  }
}

modulesRouter.put('/:key', guildAccess('ADMIN'), async (req, res) => {
  const guildId = req.guildId!;
  const key = moduleKey(req.params.key);
  const body = validate(z.object({ enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional() }), req.body);
  const existing = await prisma.guildModule.findUnique({ where: { guildId_moduleKey: { guildId, moduleKey: key } } });

  let config: Prisma.InputJsonValue | undefined;
  if (body.config) {
    const parsed = (MODULES[key].schema as unknown as z.ZodType).safeParse(body.config);
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'VALIDATION', parsed.error.issues);
    }
    config = parsed.data as Prisma.InputJsonValue;
  }

  const row = await prisma.guildModule.upsert({
    where: { guildId_moduleKey: { guildId, moduleKey: key } },
    create: { guildId, moduleKey: key, enabled: body.enabled ?? MODULES[key].defaultEnabled, config: config ?? {} },
    update: { ...(body.enabled !== undefined ? { enabled: body.enabled } : {}), ...(config ? { config } : {}) },
  });

  if (key === 'leveling' && config) {
    const before = JSON.stringify(parseModuleConfig('leveling', existing?.config ?? {}).curve);
    const after = JSON.stringify(parseModuleConfig('leveling', row.config).curve);
    if (before !== after) await recalcLevels(guildId);
  }

  await apiBus().publishConfigChange(guildId, key);
  await apiBus().publishEvent(guildId, 'config.updated', { module: key, enabled: row.enabled, by: req.session.user!.id });
  res.json({ key, enabled: row.enabled, config: parseModuleConfig(key, row.config), updatedAt: row.updatedAt });
});

modulesRouter.post('/:key/reset', guildAccess('ADMIN'), async (req, res) => {
  const guildId = req.guildId!;
  const key = moduleKey(req.params.key);
  const row = await prisma.guildModule.upsert({
    where: { guildId_moduleKey: { guildId, moduleKey: key } },
    create: { guildId, moduleKey: key, enabled: MODULES[key].defaultEnabled, config: {} },
    update: { config: {} },
  });
  if (key === 'leveling') await recalcLevels(guildId);
  await apiBus().publishConfigChange(guildId, key);
  res.json({ key, enabled: row.enabled, config: parseModuleConfig(key, {}) });
});

/** Löscht die gespeicherten Daten eines Moduls (nur Server-Besitzer). */
modulesRouter.post('/:key/data/reset', guildAccess('OWNER'), async (req, res) => {
  const guildId = req.guildId!;
  const key = moduleKey(req.params.key);
  const confirm = validate(z.object({ confirm: z.literal(key) }), req.body);
  void confirm;
  switch (key) {
    case 'moderation':
      await prisma.modCase.deleteMany({ where: { guildId } });
      break;
    case 'logging':
      await prisma.logEntry.deleteMany({ where: { guildId } });
      break;
    case 'leveling':
      await prisma.memberProfile.updateMany({ where: { guildId }, data: { xp: 0, level: 0 } });
      await prisma.memberDailyStat.updateMany({ where: { guildId }, data: { xp: 0 } });
      break;
    case 'tickets':
      await prisma.ticket.deleteMany({ where: { guildId, status: 'CLOSED' } });
      break;
    case 'economy':
      await prisma.$transaction([
        prisma.inventoryItem.deleteMany({ where: { guildId } }),
        prisma.trade.deleteMany({ where: { guildId } }),
        prisma.transaction.deleteMany({ where: { guildId } }),
        prisma.economyAccount.deleteMany({ where: { guildId } }),
        prisma.company.deleteMany({ where: { guildId } }),
      ]);
      break;
    case 'automation':
      await prisma.automation.deleteMany({ where: { guildId } });
      await prisma.reminder.deleteMany({ where: { guildId } });
      await prisma.moduleData.deleteMany({ where: { guildId, moduleKey: 'automation' } });
      await apiBus().publishConfigChange(guildId, 'automation');
      break;
    default:
      throw new HttpError(400, 'Dieses Modul speichert keine zurücksetzbaren Daten.', 'VALIDATION');
  }
  res.json({ ok: true, data: await dataStats(guildId, key) });
});

modulesRouter.post('/welcome/test', guildAccess('ADMIN'), async (req, res) => {
  res.json(await apiBus().call('welcome.test', { guildId: req.guildId!, actorId: req.session.user!.id }));
});
