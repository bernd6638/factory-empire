/**
 * End-to-End-Test der API: echte Express-App, PostgreSQL, Redis, Session-Cookie,
 * simulierter Bot (RPC über Redis) und WebSocket-Live-Events.
 * Ausführen mit: INTEGRATION=1 npm test
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = process.env.INTEGRATION === '1';

describe.skipIf(!run)('API (End-to-End)', () => {
  const guildId = '910000000000000001';
  const ownerId = '910000000000000099';
  const outsiderGuild = '910000000000000002';
  let base = '';
  let cookie = '';
  let server: Server;
  let stopWs: () => void;
  let fakeBot: import('../src/shared/bus').Bus;
  let prisma: typeof import('../src/shared/prisma').prisma;
  let redis: typeof import('../src/shared/redis').redis;

  const req = async (method: string, path: string, body?: unknown, opts: { csrf?: boolean; auth?: boolean } = {}) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.csrf === false ? {} : { 'X-Requested-With': 'DiscordOS' }),
        ...(opts.auth === false ? {} : { Cookie: cookie }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  beforeAll(async () => {
    const { env } = await import('../src/shared/env');
    const e = env();
    prisma = (await import('../src/shared/prisma')).prisma;
    redis = (await import('../src/shared/redis')).redis;
    const { Bus, BOT_STATUS_KEY } = await import('../src/shared/bus');
    const { encrypt } = await import('../src/shared/crypto');
    const { createApp } = await import('../src/api/index');
    const { attachWebSocket } = await import('../src/api/ws');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const signature = require('cookie-signature') as { sign: (v: string, s: string) => string };

    await prisma.guild.deleteMany({ where: { id: guildId } });
    await prisma.guild.create({ data: { id: guildId, name: 'E2E-Server', memberCount: 42 } });
    await prisma.auditLog.deleteMany({ where: { guildId } });

    // Angemeldete Session direkt in Redis anlegen (statt Discord-OAuth)
    const sid = `e2e-${Date.now()}`;
    await redis().set(
      `dos:sess:${sid}`,
      JSON.stringify({
        cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000).toISOString(), httpOnly: true, path: '/', sameSite: 'lax' },
        user: { id: ownerId, username: 'tester', globalName: 'Tester', avatar: null },
        tokens: encrypt(JSON.stringify({ a: 'x', r: 'y' }), e.ENCRYPTION_KEY),
        tokenExpiresAt: Date.now() + 3600000,
      }),
      'EX',
      3600,
    );
    cookie = `dos.sid=${encodeURIComponent(`s:${signature.sign(sid, e.SESSION_SECRET)}`)}`;
    // Serverliste des Nutzers vorbelegen: Besitzer von guildId, ohne Rechte auf outsiderGuild
    await redis().set(
      `dos:userguilds:${ownerId}`,
      JSON.stringify([
        { id: guildId, name: 'E2E-Server', icon: null, owner: true, permissions: '0' },
        { id: outsiderGuild, name: 'Fremd', icon: null, owner: false, permissions: '0' },
      ]),
      'EX',
      600,
    );

    // Simulierter Bot
    await redis().set(BOT_STATUS_KEY, JSON.stringify({ online: true, ping: 42 }), 'EX', 600);
    fakeBot = new Bus('e2e-bot');
    await fakeBot.serveRpc(async (method, params) => {
      if (method === 'guild.info') return { id: params.guildId, name: 'E2E-Server', memberCount: 42, botMissing: [] };
      if (method === 'guild.roles') return [{ id: guildId, name: '@everyone' }];
      if (method === 'mod.action') return { caseNumber: 1, type: params.type, userId: params.userId };
      if (method === 'guild.member') return null;
      if (method === 'message.send') return { messageId: '910000000000000123', url: 'https://discord.com/channels/x' };
      throw new Error(`unerwartet: ${method}`);
    });

    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    stopWs = attachWebSocket(server);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    stopWs?.();
    server?.close();
    await fakeBot?.close();
    await prisma.automation.deleteMany({ where: { guildId } });
    await prisma.shopItem.deleteMany({ where: { guildId } });
    await prisma.guild.deleteMany({ where: { id: guildId } });
    await prisma.dashboardPermission.deleteMany({ where: { guildId } });
    await prisma.auditLog.deleteMany({ where: { guildId } });
    await prisma.$disconnect();
    await redis().quit();
  });

  it('verweigert Zugriff ohne Anmeldung und ohne CSRF-Header', async () => {
    expect((await req('GET', '/guilds', undefined, { auth: false })).status).toBe(401);
    expect((await req('PUT', `/guilds/${guildId}/modules/leveling`, { enabled: true }, { csrf: false })).status).toBe(403);
  });

  it('liefert Profil, Serverliste und Serverdetails', async () => {
    const me = await req('GET', '/auth/me');
    expect(me.body.username).toBe('tester');
    const guilds = await req('GET', '/guilds');
    expect(guilds.body).toHaveLength(1); // fremder Server ohne Rechte wird ausgeblendet
    expect(guilds.body[0]).toMatchObject({ id: guildId, botPresent: true, access: 'OWNER' });
    const detail = await req('GET', `/guilds/${guildId}`);
    expect(detail.body.live.name).toBe('E2E-Server');
    expect(detail.body.modules.moderation).toBe(true);
  });

  it('verweigert Server ohne Berechtigung', async () => {
    await prisma.guild.upsert({ where: { id: outsiderGuild }, create: { id: outsiderGuild, name: 'Fremd' }, update: {} });
    expect((await req('GET', `/guilds/${outsiderGuild}/overview`)).status).toBe(403);
    await prisma.guild.delete({ where: { id: outsiderGuild } });
  });

  it('speichert Modul-Einstellungen dauerhaft und validiert sie', async () => {
    const bad = await req('PUT', `/guilds/${guildId}/modules/leveling`, { config: { xpMin: -5 } });
    expect(bad.status).toBe(400);
    const cfg = (await req('GET', `/guilds/${guildId}/modules/leveling`)).body.config;
    cfg.xpMin = 7;
    const ok = await req('PUT', `/guilds/${guildId}/modules/leveling`, { config: cfg, enabled: false });
    expect(ok.status).toBe(200);
    const row = await prisma.guildModule.findUnique({ where: { guildId_moduleKey: { guildId, moduleKey: 'leveling' } } });
    expect(row?.enabled).toBe(false);
    expect((row?.config as { xpMin: number }).xpMin).toBe(7);
  });

  it('Automatisierungen: Anlegen mit Zeitplan, Umschalten, Löschen', async () => {
    const created = await req('POST', `/guilds/${guildId}/automations`, {
      name: 'Wochenbericht',
      trigger: 'SCHEDULE',
      triggerConfig: { cron: '0 9 * * 1' },
      actions: [{ type: 'SEND_MESSAGE', channelId: '910000000000000050', content: 'Neue Woche!' }],
    });
    expect(created.status).toBe(201);
    expect(new Date(created.body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    const invalid = await req('POST', `/guilds/${guildId}/automations`, { name: 'X', trigger: 'SCHEDULE', triggerConfig: { cron: 'quatsch kein cron' }, actions: [{ type: 'DELETE_MESSAGE' }] });
    expect(invalid.status).toBe(400);
    expect((await req('POST', `/guilds/${guildId}/automations/${created.body.id}/toggle`)).body.enabled).toBe(false);
    expect((await req('DELETE', `/guilds/${guildId}/automations/${created.body.id}`)).status).toBe(200);
  });

  it('Economy-Shop: CRUD', async () => {
    const item = await req('POST', `/guilds/${guildId}/economy/shop`, { name: 'VIP-Pass', price: 500, emoji: '⭐' });
    expect(item.status).toBe(201);
    expect((await req('POST', `/guilds/${guildId}/economy/shop`, { name: 'VIP-Pass', price: 1 })).status).toBe(409);
    expect((await req('PATCH', `/guilds/${guildId}/economy/shop/${item.body.id}`, { price: 750 })).body.price).toBe(750);
    expect((await req('GET', `/guilds/${guildId}/economy/shop`)).body).toHaveLength(1);
    expect((await req('DELETE', `/guilds/${guildId}/economy/shop/${item.body.id}`)).status).toBe(200);
  });

  it('Moderationsaktion wird an den Bot weitergeleitet', async () => {
    const res = await req('POST', `/guilds/${guildId}/moderation/actions`, { type: 'WARN', userId: '910000000000000077', reason: 'Test' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ caseNumber: 1, type: 'WARN' });
  });

  it('Nachricht als Bot senden', async () => {
    const res = await req('POST', `/guilds/${guildId}/messages`, { channelId: '910000000000000050', payload: { content: 'Hallo!' } });
    expect(res.status).toBe(201);
    expect(res.body.messageId).toBe('910000000000000123');
    expect((await req('POST', `/guilds/${guildId}/messages`, { channelId: 'kein-kanal', payload: {} })).status).toBe(400);
  });

  it('Dashboard-Berechtigungen und Audit-Log', async () => {
    const perm = await req('POST', `/guilds/${guildId}/settings/permissions`, { targetType: 'ROLE', targetId: '910000000000000060', level: 'MODERATOR' });
    expect(perm.status).toBe(201);
    const everyoneAdmin = await req('POST', `/guilds/${guildId}/settings/permissions`, { targetType: 'ROLE', targetId: guildId, level: 'ADMIN' });
    expect(everyoneAdmin.status).toBe(400);
    await new Promise((r) => setTimeout(r, 200));
    const audit = await req('GET', `/guilds/${guildId}/settings/audit`);
    expect(audit.body.total).toBeGreaterThan(3);
    expect(audit.body.items.map((i: { action: string }) => i.action)).toContain('POST /settings/permissions');
  });

  it('Übersicht und Logs liefern Daten', async () => {
    const ov = await req('GET', `/guilds/${guildId}/overview?days=7`);
    expect(ov.status).toBe(200);
    expect(ov.body.series).toHaveLength(7);
    expect(ov.body.hourly).toHaveLength(24);
    expect((await req('GET', `/guilds/${guildId}/logs`)).body.items).toEqual([]);
  });

  it('WebSocket: Abonnement und Live-Event', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie } });
    const messages: { type: string }[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'subscribe', guildId }));
    await new Promise((r) => setTimeout(r, 300));
    await fakeBot.publishEvent(guildId, 'member.join', { id: '1', memberCount: 43 });
    await fakeBot.publishEvent('999999999999999999', 'member.join', { id: '2' }); // fremder Server → nicht zustellen
    await new Promise((r) => setTimeout(r, 300));
    ws.close();
    const types = messages.map((m) => m.type);
    expect(types).toContain('subscribed');
    expect(types.filter((t) => t === 'member.join')).toHaveLength(1);

    const anon = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const err = await new Promise<string>((r) => anon.once('unexpected-response', (_req, res) => r(String(res.statusCode))));
    expect(err).toBe('401');
  });
});
