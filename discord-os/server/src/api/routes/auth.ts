import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { PermissionsBitField } from 'discord.js';
import { prisma } from '../../shared/prisma';
import { env } from '../../shared/env';
import { getBotStatus } from '../../shared/bus';
import { decrypt } from '../../shared/crypto';
import { authorizeUrl, discordGet, exchangeCode, revokeToken, storeTokens, userAvatarUrl, type DiscordUser } from '../discord';
import { audit } from '../audit';
import { HttpError } from '../http';

/** Berechtigungen, die der Bot für alle Module benötigt (Einladungslink). */
export const BOT_PERMISSIONS = new PermissionsBitField([
  'ViewChannel', 'SendMessages', 'SendPolls', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'AddReactions', 'UseExternalEmojis',
  'ManageMessages', 'ManageChannels', 'ManageRoles', 'ManageGuild', 'ViewAuditLog',
  'KickMembers', 'BanMembers', 'ModerateMembers', 'ManageNicknames',
  'Connect', 'Speak', 'MoveMembers',
]).bitfield.toString();

export function inviteUrl(guildId?: string) {
  const p = new URLSearchParams({ client_id: env().DISCORD_CLIENT_ID, scope: 'bot applications.commands', permissions: BOT_PERMISSIONS });
  if (guildId) {
    p.set('guild_id', guildId);
    p.set('disable_guild_select', 'true');
  }
  return `https://discord.com/oauth2/authorize?${p}`;
}

export const authRouter = Router();

authRouter.get('/login', (req, res) => {
  const state = randomBytes(24).toString('hex');
  req.session.oauthState = state;
  const returnTo = typeof req.query.returnTo === 'string' && req.query.returnTo.startsWith('/') && !req.query.returnTo.startsWith('//') ? req.query.returnTo : '/servers';
  req.session.returnTo = returnTo;
  req.session.save(() => res.redirect(authorizeUrl(state)));
});

authRouter.get('/callback', async (req, res, next) => {
  const base = env().PUBLIC_URL;
  try {
    const { code, state, error } = req.query;
    if (error) return res.redirect(`${base}/login?error=denied`);
    if (typeof code !== 'string' || typeof state !== 'string' || !req.session.oauthState || state !== req.session.oauthState) {
      return res.redirect(`${base}/login?error=state`);
    }
    const returnTo = req.session.returnTo ?? '/servers';
    const tokens = await exchangeCode(code);
    const me = await discordGet<DiscordUser>('/users/@me', tokens.access_token);

    // Session-Fixation verhindern: neue Session-ID nach dem Login
    await new Promise<void>((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    req.session.user = { id: me.id, username: me.username, globalName: me.global_name, avatar: me.avatar };
    storeTokens(req.session, tokens);
    await new Promise<void>((resolve) => req.session.save(() => resolve()));

    await prisma.user.upsert({
      where: { id: me.id },
      create: { id: me.id, username: me.username, avatar: me.avatar },
      update: { username: me.username, avatar: me.avatar, lastLogin: new Date() },
    });
    await audit(null, me.id, 'auth.login', {}, req.ip);
    res.redirect(`${base}${returnTo}`);
  } catch (err) {
    if (err instanceof HttpError) return res.redirect(`${base}/login?error=oauth`);
    next(err);
  }
});

authRouter.post('/logout', async (req, res) => {
  const tokens = req.session.tokens;
  const userId = req.session.user?.id;
  if (tokens) {
    try {
      const { a } = JSON.parse(decrypt(tokens, env().ENCRYPTION_KEY)) as { a: string };
      void revokeToken(a);
    } catch {
      /* ignorieren */
    }
  }
  if (userId) await audit(null, userId, 'auth.logout', {}, req.ip);
  req.session.destroy(() => {
    res.clearCookie('dos.sid');
    res.json({ ok: true });
  });
});

authRouter.get('/me', (req, res) => {
  const u = req.session.user;
  if (!u) {
    res.status(401).json({ error: 'Nicht angemeldet', code: 'UNAUTHORIZED' });
    return;
  }
  res.json({ ...u, avatarUrl: userAvatarUrl(u.id, u.avatar), botOwner: env().BOT_OWNER_IDS.includes(u.id) });
});

export const metaRouter = Router();

metaRouter.get('/', async (_req, res) => {
  res.json({ name: 'Discord OS', version: '1.0.0', clientId: env().DISCORD_CLIENT_ID, inviteUrl: inviteUrl(), bot: await getBotStatus() });
});

metaRouter.get('/health', async (_req, res) => {
  const [db, bot] = await Promise.all([
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    getBotStatus(),
  ]);
  res.status(db ? 200 : 503).json({ ok: db, database: db, bot: !!bot?.online, time: new Date().toISOString() });
});
