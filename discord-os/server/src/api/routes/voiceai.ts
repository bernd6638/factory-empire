import { Router } from 'express';
import { z } from 'zod';
import { snowflake } from '../../shared/modules';
import { guildAccess } from '../access';
import { apiBus } from '../bus';
import { validate } from '../http';

/** KI-Sprach-Bot: Status, Sprachkanal betreten/verlassen, Modell laden, Tests. */
export const voiceaiRouter = Router({ mergeParams: true });

voiceaiRouter.get('/', guildAccess('VIEWER'), async (req, res) => {
  const [session, health] = await Promise.all([
    apiBus().call('voiceai.status', { guildId: req.guildId }),
    apiBus().call('voiceai.health', { guildId: req.guildId }, 12_000),
  ]);
  res.json({ session, health });
});

voiceaiRouter.post('/join', guildAccess('MODERATOR'), async (req, res) => {
  const body = validate(z.object({ channelId: snowflake }), req.body);
  res.json(await apiBus().call('voiceai.join', { guildId: req.guildId, channelId: body.channelId }, 30_000));
});

voiceaiRouter.post('/leave', guildAccess('MODERATOR'), async (req, res) => {
  res.json(await apiBus().call('voiceai.leave', { guildId: req.guildId }));
});

voiceaiRouter.post('/reset', guildAccess('MODERATOR'), async (req, res) => {
  res.json(await apiBus().call('voiceai.reset', { guildId: req.guildId }));
});

voiceaiRouter.post('/pull', guildAccess('ADMIN'), async (req, res) => {
  const body = validate(z.object({ model: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._:/-]+$/, 'Ungültiger Modellname') }), req.body);
  res.json(await apiBus().call('voiceai.pull', { guildId: req.guildId, model: body.model }));
});

voiceaiRouter.post('/ask', guildAccess('MODERATOR'), async (req, res) => {
  const body = validate(z.object({ text: z.string().min(1).max(500) }), req.body);
  const u = req.session.user!;
  res.json(await apiBus().call('voiceai.ask', { guildId: req.guildId, text: body.text, name: u.globalName ?? u.username }, 95_000));
});

voiceaiRouter.post('/say', guildAccess('MODERATOR'), async (req, res) => {
  const body = validate(z.object({ text: z.string().min(1).max(500) }), req.body);
  res.json(await apiBus().call('voiceai.say', { guildId: req.guildId, text: body.text }, 60_000));
});
