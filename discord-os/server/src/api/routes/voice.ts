import { Router } from 'express';
import { snowflake } from '../../shared/modules';
import { guildAccess } from '../access';
import { apiBus } from '../bus';
import { validate } from '../http';

export const voiceRouter = Router({ mergeParams: true });

voiceRouter.get('/', guildAccess('VIEWER'), async (req, res) => {
  res.json(await apiBus().call('voice.list', { guildId: req.guildId! }));
});

voiceRouter.delete('/channels/:channelId', guildAccess('MODERATOR'), async (req, res) => {
  res.json(await apiBus().call('voice.delete', { guildId: req.guildId!, channelId: validate(snowflake, req.params.channelId) }));
});
