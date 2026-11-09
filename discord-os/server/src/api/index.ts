import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { RedisStore as RateLimitStore } from 'rate-limit-redis';
import { env } from '../shared/env';
import { redis } from '../shared/redis';
import { childLogger } from '../shared/logger';
import { sessionMiddleware } from './session';
import { requireAuth } from './access';
import { auditMiddleware } from './audit';
import { errorHandler, HttpError } from './http';
import { attachWebSocket } from './ws';
import { apiBus } from './bus';
import { authRouter, metaRouter } from './routes/auth';
import { guildsRouter } from './routes/guilds';
import { serverRouter } from './routes/server';
import { membersRouter } from './routes/members';
import { moderationRouter } from './routes/moderation';
import { levelingRouter } from './routes/leveling';
import { ticketsRouter } from './routes/tickets';
import { economyRouter } from './routes/economy';
import { automationsRouter } from './routes/automations';
import { voiceRouter } from './routes/voice';
import { logsRouter } from './routes/logs';
import { modulesRouter } from './routes/modules';
import { settingsRouter } from './routes/settings';
import { messagesRouter } from './routes/messages';
import { giveawaysRouter } from './routes/giveaways';
import { controlRouter } from './routes/control';
import { voiceaiRouter } from './routes/voiceai';

const log = childLogger('api');

function limiter(windowMs: number, limit: number, prefix: string) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Zu viele Anfragen – bitte kurz warten.', code: 'RATE_LIMITED' },
    keyGenerator: (req) => req.session?.user?.id ?? req.ip ?? 'unknown',
    store: new RateLimitStore({
      prefix: `dos:rl:${prefix}:`,
      sendCommand: (...args: string[]) => redis().call(args[0]!, ...args.slice(1)) as Promise<never>,
    }),
  });
}

/** CSRF-Schutz: ändernde Anfragen müssen den eigenen Header tragen und vom eigenen Origin kommen. */
function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && origin !== new URL(env().PUBLIC_URL).origin) return next(new HttpError(403, 'Ungültiger Origin', 'CSRF'));
  if (req.headers['x-requested-with'] !== 'DiscordOS') return next(new HttpError(403, 'Ungültige Anfrage', 'CSRF'));
  next();
}

export function createApp() {
  const e = env();
  const app = express();
  app.disable('x-powered-by');
  if (e.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'img-src': ["'self'", 'data:', 'https://cdn.discordapp.com', 'https://media.discordapp.net'],
          'connect-src': ["'self'", e.PUBLIC_URL.replace(/^http/, 'ws')],
          'style-src': ["'self'", "'unsafe-inline'"],
          'font-src': ["'self'", 'data:'],
          'upgrade-insecure-requests': e.PUBLIC_URL.startsWith('https://') ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: e.PUBLIC_URL.startsWith('https://') ? undefined : false,
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(sessionMiddleware());

  const api = Router();
  api.use(limiter(60_000, 300, 'api'));
  api.use(csrfGuard);
  api.use('/meta', metaRouter);
  api.use('/auth', limiter(60_000, 30, 'auth'), authRouter);

  const guild = Router({ mergeParams: true });
  guild.use(auditMiddleware);
  guild.use('/server', serverRouter);
  guild.use('/members', membersRouter);
  guild.use('/moderation', moderationRouter);
  guild.use('/leveling', levelingRouter);
  guild.use('/tickets', ticketsRouter);
  guild.use('/economy', economyRouter);
  guild.use('/automations', automationsRouter);
  guild.use('/voice', voiceRouter);
  guild.use('/logs', logsRouter);
  guild.use('/modules', modulesRouter);
  guild.use('/settings', settingsRouter);
  guild.use('/messages', messagesRouter);
  guild.use('/giveaways', giveawaysRouter);
  guild.use('/control', controlRouter);
  guild.use('/voiceai', voiceaiRouter);

  api.use('/guilds', requireAuth, guildsRouter);
  api.use('/guilds/:guildId', requireAuth, guild);
  api.use((_req, _res, next) => next(new HttpError(404, 'Endpunkt nicht gefunden', 'NOT_FOUND')));
  app.use('/api', api);

  // Gebautes Frontend ausliefern (SPA-Fallback auf index.html)
  const webDist = path.resolve(__dirname, '../../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false, maxAge: '1h', setHeaders: (res, file) => file.includes(`${path.sep}assets${path.sep}`) && res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') }));
    app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  } else {
    app.get('/', (_req, res) => res.type('text/plain').send('Discord OS API läuft. Frontend nicht gebaut – "npm run build" ausführen oder "npm run dev" für die Entwicklung nutzen.'));
  }

  app.use(errorHandler);
  return app;
}

export async function startApi(): Promise<() => Promise<void>> {
  const e = env();
  const app = createApp();
  const server = http.createServer(app);
  const stopWs = attachWebSocket(server);
  apiBus(); // Bus früh initialisieren
  await new Promise<void>((resolve) => server.listen(e.API_PORT, e.API_HOST, resolve));
  log.info(`Dashboard & API: ${e.PUBLIC_URL} (lauscht auf ${e.API_HOST}:${e.API_PORT})`);
  return async () => {
    stopWs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await apiBus().close();
  };
}
