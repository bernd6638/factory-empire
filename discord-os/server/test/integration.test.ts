/**
 * Integrationstests gegen echte PostgreSQL- und Redis-Instanzen.
 * Ausführen mit: INTEGRATION=1 npm test   (benötigt eine gültige .env und laufende Dienste)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = process.env.INTEGRATION === '1';

describe.skipIf(!run)('Integration (Datenbank & Redis)', () => {
  const guildId = '900000000000000001';
  let prisma: typeof import('../src/shared/prisma').prisma;
  let Bus: typeof import('../src/shared/bus').Bus;
  let redis: typeof import('../src/shared/redis').redis;

  beforeAll(async () => {
    await import('../src/shared/env').then((m) => m.env());
    prisma = (await import('../src/shared/prisma')).prisma;
    Bus = (await import('../src/shared/bus')).Bus;
    redis = (await import('../src/shared/redis')).redis;
    await prisma.guild.deleteMany({ where: { id: guildId } });
    await prisma.guild.create({ data: { id: guildId, name: 'Testserver' } });
  });

  afterAll(async () => {
    await prisma.memberDailyStat.deleteMany({ where: { guildId } });
    await prisma.guildStatHour.deleteMany({ where: { guildId } });
    await prisma.guild.deleteMany({ where: { id: guildId } });
    await prisma.$disconnect();
    await redis().quit();
  });

  it('StatsService schreibt Zähler gebündelt per Bulk-Upsert', async () => {
    const { StatsService } = await import('../src/bot/core/StatsService');
    const flushed: string[] = [];
    const stats = new StatsService((g) => flushed.push(g));
    const user = { id: '900000000000000010', username: 'tester', avatar: null, bot: false };
    stats.message(guildId, user);
    stats.message(guildId, user);
    stats.xp(guildId, user, 20);
    stats.join(guildId);
    stats.message('999999999999999999', user); // unbekannter Server wird ignoriert
    await stats.flush();
    stats.message(guildId, user);
    await stats.flush();

    const profile = await prisma.memberProfile.findUnique({ where: { guildId_userId: { guildId, userId: user.id } } });
    expect(profile?.messages).toBe(3);
    const daily = await prisma.memberDailyStat.findFirst({ where: { guildId, userId: user.id } });
    expect(daily?.messages).toBe(3);
    expect(daily?.xp).toBe(20);
    const hour = await prisma.guildStatHour.findFirst({ where: { guildId } });
    expect(hour?.messages).toBe(3);
    expect(hour?.joins).toBe(1);
    expect(flushed).toContain(guildId);
  });

  it('ConfigService legt Standardkonfiguration an und cacht sie', async () => {
    const { ConfigService } = await import('../src/bot/core/ConfigService');
    const cs = new ConfigService();
    const entry = await cs.get(guildId, 'leveling');
    expect(entry.enabled).toBe(true);
    expect(entry.config.xpMin).toBe(15);
    await cs.patch(guildId, 'leveling', (c) => {
      c.xpMin = 5;
    });
    expect((await cs.get(guildId, 'leveling')).config.xpMin).toBe(5);
  });

  it('Bus: RPC-Aufruf zwischen zwei Instanzen und Live-Events', async () => {
    const { BOT_STATUS_KEY } = await import('../src/shared/bus');
    await redis().set(BOT_STATUS_KEY, JSON.stringify({ online: true }), 'EX', 30);
    const bot = new Bus('test-bot');
    const api = new Bus('test-api');
    await bot.serveRpc(async (method, params) => {
      if (method === 'echo') return { echo: params };
      throw new Error('unbekannt');
    });
    const events: unknown[] = [];
    await api.onEvent((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 100));
    expect(await api.call('echo', { a: 1 })).toEqual({ echo: { a: 1 } });
    await expect(api.call('fail')).rejects.toThrow();
    await bot.publishEvent(guildId, 'test', { ok: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toHaveLength(1);
    await redis().del(BOT_STATUS_KEY);
    await expect(api.call('echo', {})).rejects.toThrow('nicht erreichbar');
    await bot.close();
    await api.close();
  });
});
