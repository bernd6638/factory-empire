import type { Session, SessionData } from 'express-session';
import { env } from '../shared/env';
import { decrypt, encrypt } from '../shared/crypto';
import { redis } from '../shared/redis';
import { HttpError } from './http';

const API = 'https://discord.com/api/v10';

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export interface PartialGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
}

export function redirectUri() {
  return `${env().PUBLIC_URL}/api/auth/callback`;
}

export function authorizeUrl(state: string) {
  const p = new URLSearchParams({
    client_id: env().DISCORD_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'identify guilds',
    state,
    prompt: 'none',
  });
  return `https://discord.com/oauth2/authorize?${p}`;
}

async function tokenRequest(body: Record<string, string>): Promise<OAuthTokens> {
  const e = env();
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: e.DISCORD_CLIENT_ID, client_secret: e.DISCORD_CLIENT_SECRET, ...body }),
  });
  if (!res.ok) throw new HttpError(401, 'Anmeldung bei Discord fehlgeschlagen.', 'OAUTH_FAILED');
  return (await res.json()) as OAuthTokens;
}

export function exchangeCode(code: string) {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
}

export async function revokeToken(token: string) {
  const e = env();
  await fetch(`${API}/oauth2/token/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: e.DISCORD_CLIENT_ID, client_secret: e.DISCORD_CLIENT_SECRET, token }),
  }).catch(() => undefined);
}

export function storeTokens(session: Session & Partial<SessionData>, tokens: OAuthTokens) {
  session.tokens = encrypt(JSON.stringify({ a: tokens.access_token, r: tokens.refresh_token }), env().ENCRYPTION_KEY);
  session.tokenExpiresAt = Date.now() + tokens.expires_in * 1000 - 60_000;
}

/** Liefert ein gültiges Access-Token (erneuert es bei Bedarf über das Refresh-Token). */
export async function accessToken(session: Session & Partial<SessionData>): Promise<string> {
  if (!session.tokens) throw new HttpError(401, 'Nicht angemeldet', 'UNAUTHORIZED');
  const { a, r } = JSON.parse(decrypt(session.tokens, env().ENCRYPTION_KEY)) as { a: string; r: string };
  if ((session.tokenExpiresAt ?? 0) > Date.now()) return a;
  try {
    const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: r });
    storeTokens(session, fresh);
    await new Promise<void>((resolve) => session.save(() => resolve()));
    return fresh.access_token;
  } catch {
    throw new HttpError(401, 'Sitzung abgelaufen – bitte erneut anmelden.', 'SESSION_EXPIRED');
  }
}

export async function discordGet<T>(path: string, token: string): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '1');
      await new Promise((r) => setTimeout(r, Math.min(retry, 5) * 1000));
      continue;
    }
    if (res.status === 401) throw new HttpError(401, 'Sitzung abgelaufen – bitte erneut anmelden.', 'SESSION_EXPIRED');
    if (!res.ok) throw new HttpError(502, 'Discord-API nicht erreichbar.', 'DISCORD_ERROR');
    return (await res.json()) as T;
  }
  throw new HttpError(429, 'Discord-Ratenlimit erreicht, bitte kurz warten.', 'RATE_LIMITED');
}

/** Server-Liste des Nutzers (60 s in Redis zwischengespeichert, Discord-Limit beachten). */
export async function userGuilds(session: Session & Partial<SessionData>, force = false): Promise<PartialGuild[]> {
  const user = session.user;
  if (!user) throw new HttpError(401, 'Nicht angemeldet', 'UNAUTHORIZED');
  const key = `dos:userguilds:${user.id}`;
  if (!force) {
    const hit = await redis().get(key);
    if (hit) return JSON.parse(hit) as PartialGuild[];
  }
  const token = await accessToken(session);
  const guilds = await discordGet<PartialGuild[]>('/users/@me/guilds', token);
  await redis().set(key, JSON.stringify(guilds), 'EX', 60);
  return guilds;
}

export function guildIconUrl(id: string, icon: string | null) {
  return icon ? `https://cdn.discordapp.com/icons/${id}/${icon}.${icon.startsWith('a_') ? 'gif' : 'png'}?size=128` : null;
}

export function userAvatarUrl(id: string, avatar: string | null) {
  if (avatar) return `https://cdn.discordapp.com/avatars/${id}/${avatar}.${avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`;
  return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`;
}
