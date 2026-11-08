import { Router } from 'express';
import { z } from 'zod';
import { guildAccess } from '../access';
import { apiBus } from '../bus';
import { validate } from '../http';
import { snowflake } from '../../shared/modules';

/** Serververwaltung: Kanäle, Rollen, Berechtigungen, Servereinstellungen (über den Bot). */
export const serverRouter = Router({ mergeParams: true });

const roleBody = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
  permissions: z.string().regex(/^\d+$/).optional(),
});

serverRouter.get('/channels', guildAccess('VIEWER'), async (req, res) => {
  res.json(await apiBus().call('guild.channels', { guildId: req.guildId! }));
});

serverRouter.get('/roles', guildAccess('VIEWER'), async (req, res) => {
  res.json(await apiBus().call('guild.roles', { guildId: req.guildId! }));
});

serverRouter.post('/roles', guildAccess('ADMIN'), async (req, res) => {
  const body = validate(roleBody.extend({ name: z.string().min(1).max(100) }), req.body);
  res.status(201).json(await apiBus().call('guild.role.create', { ...body, guildId: req.guildId!, actorId: req.session.user!.id }));
});

serverRouter.patch('/roles/:roleId', guildAccess('ADMIN'), async (req, res) => {
  const body = validate(roleBody, req.body);
  const roleId = validate(snowflake, req.params.roleId);
  res.json(await apiBus().call('guild.role.update', { ...body, guildId: req.guildId!, roleId, actorId: req.session.user!.id }));
});

serverRouter.delete('/roles/:roleId', guildAccess('ADMIN'), async (req, res) => {
  const roleId = validate(snowflake, req.params.roleId);
  res.json(await apiBus().call('guild.role.delete', { guildId: req.guildId!, roleId, actorId: req.session.user!.id }));
});

serverRouter.put('/channels/:channelId/permissions/:targetId', guildAccess('ADMIN'), async (req, res) => {
  const body = validate(z.object({ targetType: z.enum(['role', 'member']), allow: z.string().regex(/^\d+$/), deny: z.string().regex(/^\d+$/) }), req.body);
  res.json(
    await apiBus().call('guild.channel.permissions.set', {
      ...body,
      guildId: req.guildId!,
      channelId: validate(snowflake, req.params.channelId),
      targetId: validate(snowflake, req.params.targetId),
      actorId: req.session.user!.id,
    }),
  );
});

serverRouter.delete('/channels/:channelId/permissions/:targetId', guildAccess('ADMIN'), async (req, res) => {
  res.json(
    await apiBus().call('guild.channel.permissions.delete', {
      guildId: req.guildId!,
      channelId: validate(snowflake, req.params.channelId),
      targetId: validate(snowflake, req.params.targetId),
      actorId: req.session.user!.id,
    }),
  );
});

serverRouter.patch('/settings', guildAccess('ADMIN'), async (req, res) => {
  const body = validate(
    z.object({
      name: z.string().min(2).max(100).optional(),
      verificationLevel: z.number().int().min(0).max(4).optional(),
      explicitContentFilter: z.number().int().min(0).max(2).optional(),
      defaultMessageNotifications: z.number().int().min(0).max(1).optional(),
      systemChannelId: snowflake.nullable().optional(),
      afkChannelId: snowflake.nullable().optional(),
      afkTimeout: z.number().int().optional(),
    }),
    req.body,
  );
  res.json(await apiBus().call('guild.settings.update', { ...body, guildId: req.guildId!, actorId: req.session.user!.id }));
});

serverRouter.get('/commands', guildAccess('VIEWER'), async (_req, res) => {
  res.json(await apiBus().call('bot.commands', {}));
});
