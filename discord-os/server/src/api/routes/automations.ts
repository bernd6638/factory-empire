import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/prisma';
import { automationInputSchema, nextCronRun, triggerConfigSchemas, TRIGGERS, ACTION_LABELS } from '../../shared/automation';
import { parseModuleConfig, snowflake } from '../../shared/modules';
import { TEMPLATE_VARIABLES } from '../../shared/template';
import { guildAccess } from '../access';
import { apiBus } from '../bus';
import { HttpError, intParam, validate } from '../http';
import { z } from 'zod';

export const automationsRouter = Router({ mergeParams: true });

async function timezone(guildId: string) {
  const row = await prisma.guildModule.findUnique({ where: { guildId_moduleKey: { guildId, moduleKey: 'automation' } } });
  return parseModuleConfig('automation', row?.config ?? {}).timezone;
}

async function prepare(guildId: string, body: unknown) {
  const input = validate(automationInputSchema, body);
  const triggerConfig = triggerConfigSchemas[input.trigger].parse(input.triggerConfig) as Record<string, unknown>;
  let nextRunAt: Date | null = null;
  if (input.trigger === 'SCHEDULE') {
    nextRunAt = nextCronRun(String(triggerConfig.cron), await timezone(guildId));
    if (!nextRunAt) throw new HttpError(400, 'Ungültiger Cron-Ausdruck (z. B. "0 9 * * 1" = montags 9 Uhr).', 'VALIDATION');
  }
  return {
    name: input.name,
    enabled: input.enabled,
    trigger: input.trigger,
    triggerConfig: triggerConfig as Prisma.InputJsonValue,
    conditions: input.conditions as Prisma.InputJsonValue,
    actions: input.actions as Prisma.InputJsonValue,
    nextRunAt,
  };
}

automationsRouter.get('/meta', guildAccess('VIEWER'), (_req, res) => {
  res.json({ triggers: TRIGGERS, actions: ACTION_LABELS, variables: TEMPLATE_VARIABLES });
});

automationsRouter.get('/', guildAccess('VIEWER'), async (req, res) => {
  res.json(await prisma.automation.findMany({ where: { guildId: req.guildId! }, orderBy: { createdAt: 'desc' } }));
});

automationsRouter.post('/', guildAccess('ADMIN'), async (req, res) => {
  const guildId = req.guildId!;
  if ((await prisma.automation.count({ where: { guildId } })) >= 100) throw new HttpError(400, 'Maximal 100 Automatisierungen pro Server.', 'LIMIT');
  const data = await prepare(guildId, req.body);
  const rule = await prisma.automation.create({ data: { ...data, guildId } });
  await apiBus().publishConfigChange(guildId, 'automation');
  res.status(201).json(rule);
});

automationsRouter.put('/:id', guildAccess('ADMIN'), async (req, res) => {
  const guildId = req.guildId!;
  const id = intParam(req.params.id);
  const existing = await prisma.automation.findFirst({ where: { id, guildId } });
  if (!existing) throw new HttpError(404, 'Automatisierung nicht gefunden', 'NOT_FOUND');
  const data = await prepare(guildId, req.body);
  const rule = await prisma.automation.update({ where: { id }, data: { ...data, lastError: null } });
  await apiBus().publishConfigChange(guildId, 'automation');
  res.json(rule);
});

automationsRouter.post('/:id/toggle', guildAccess('ADMIN'), async (req, res) => {
  const guildId = req.guildId!;
  const id = intParam(req.params.id);
  const existing = await prisma.automation.findFirst({ where: { id, guildId } });
  if (!existing) throw new HttpError(404, 'Automatisierung nicht gefunden', 'NOT_FOUND');
  let nextRunAt = existing.nextRunAt;
  if (!existing.enabled && existing.trigger === 'SCHEDULE') {
    nextRunAt = nextCronRun(String((existing.triggerConfig as { cron?: string }).cron ?? ''), await timezone(guildId));
  }
  const rule = await prisma.automation.update({ where: { id }, data: { enabled: !existing.enabled, nextRunAt } });
  await apiBus().publishConfigChange(guildId, 'automation');
  res.json(rule);
});

automationsRouter.post('/:id/test', guildAccess('ADMIN'), async (req, res) => {
  const body = validate(z.object({ channelId: snowflake.nullable().optional() }), req.body ?? {});
  res.json(await apiBus().call('automation.test', { guildId: req.guildId!, ruleId: intParam(req.params.id), actorId: req.session.user!.id, channelId: body.channelId ?? null }, 30_000));
});

automationsRouter.delete('/:id', guildAccess('ADMIN'), async (req, res) => {
  const guildId = req.guildId!;
  const result = await prisma.automation.deleteMany({ where: { id: intParam(req.params.id), guildId } });
  if (!result.count) throw new HttpError(404, 'Automatisierung nicht gefunden', 'NOT_FOUND');
  await apiBus().publishConfigChange(guildId, 'automation');
  res.json({ ok: true });
});

automationsRouter.get('/reminders', guildAccess('VIEWER'), async (req, res) => {
  res.json(await prisma.reminder.findMany({ where: { guildId: req.guildId!, done: false }, orderBy: { remindAt: 'asc' }, take: 100 }));
});
