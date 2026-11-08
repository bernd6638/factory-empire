import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { env } from '../shared/env';
import { redis } from '../shared/redis';

export interface SessionUser {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
}

declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
    /** AES-256-GCM-verschlüsselte OAuth-Tokens */
    tokens?: string;
    tokenExpiresAt?: number;
    oauthState?: string;
    returnTo?: string;
  }
}

let middleware: ReturnType<typeof session> | null = null;

/** Session-Middleware (Redis-Speicher, httpOnly-Cookie, SameSite=Lax). */
export function sessionMiddleware() {
  if (middleware) return middleware;
  const e = env();
  const secure = e.PUBLIC_URL.startsWith('https://');
  middleware = session({
    name: 'dos.sid',
    store: new RedisStore({ client: redis(), prefix: 'dos:sess:' }),
    secret: e.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: e.TRUST_PROXY,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: 7 * 24 * 3600 * 1000,
    },
  });
  return middleware;
}
