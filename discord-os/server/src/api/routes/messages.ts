import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../shared/prisma';
import { snowflake } from '../../shared/modules';
import { guildAccess } from '../access';
import { apiBus } from '../bus';
import { validate } from '../http';

/** Nachrichten als Bot senden, bearbeiten und löschen. */
export const messagesRouter = Router({ mergeParams: true });

messagesRouter.get('/', guildAccess('MODERATOR'), async (req, res) => {
  const rows = await prisma.moduleData.findMany({ where: { guildId: req.guildId!, moduleKey: 'messages' }, orderBy: { updatedAt: 'desc' }, take: 50 });
  res.json(rows.map((r) => ({ messageId: r.key, ...(r.value as object) })));
});

messagesRouter.post('/', guildAccess('MODERATOR'), async (req, res) => {
  const body = validate(z.object({ channelId: snowflake, payload: z.record(z.string(), z.unknown()) }), req.body);
  res.status(201).json(await apiBus().call('message.send', { guildId: req.guildId, channelId: body.channelId, actorId: req.session.user!.id, payload: body.payload }, 20_000));
});

messagesRouter.put('/:messageId', guildAccess('MODERATOR'), async (req, res) => {
  const body = validate(z.object({ payload: z.record(z.string(), z.unknown()) }), req.body);
  res.json(await apiBus().call('message.edit', { guildId: req.guildId, messageId: validate(snowflake, req.params.messageId), actorId: req.session.user!.id, payload: body.payload }, 20_000));
});

messagesRouter.delete('/:messageId', guildAccess('MODERATOR'), async (req, res) => {
  res.json(await apiBus().call('message.delete', { guildId: req.guildId, messageId: validate(snowflake, req.params.messageId) }));
});
