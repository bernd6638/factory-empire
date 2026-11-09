import { describe, expect, it } from 'vitest';
import { computeDrawOrder, createSeed, giveawayInputSchema, hashSeed } from '../src/shared/giveaway';
import { checkEligibility } from '../src/bot/modules/giveaways';

describe('Giveaway: faire Ziehung (Commit-Reveal)', () => {
  it('Hash passt zum Seed und verrät ihn nicht', () => {
    const { seed, seedHash } = createSeed();
    expect(seed).toHaveLength(64);
    expect(hashSeed(seed)).toBe(seedHash);
    expect(seedHash).not.toContain(seed);
  });
  it('Reihenfolge ist deterministisch und unabhängig von der Eingabereihenfolge', () => {
    const users = Array.from({ length: 50 }, (_, i) => `1000000000000000${String(i).padStart(2, '0')}`);
    const a = computeDrawOrder('seed-x', users);
    const b = computeDrawOrder('seed-x', [...users].reverse());
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(50);
    expect(computeDrawOrder('seed-y', users)).not.toEqual(a);
  });
  it('Doppelte Einträge zählen nur einmal', () => {
    expect(computeDrawOrder('s', ['1', '1', '2'])).toHaveLength(2);
  });
  it('ist annähernd gleichverteilt', () => {
    const users = ['a', 'b', 'c', 'd'];
    const wins: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
    for (let i = 0; i < 4000; i++) wins[computeDrawOrder(`seed-${i}`, users)[0]!]!++;
    for (const n of Object.values(wins)) expect(n).toBeGreaterThan(850);
  });
});

describe('Giveaway: Eingaben', () => {
  it('Ende muss nach dem Start liegen', () => {
    const base = { channelId: '123456789012345678', prize: 'Nitro' };
    expect(giveawayInputSchema.safeParse({ ...base, endsAt: new Date(Date.now() + 3_600_000) }).success).toBe(true);
    expect(giveawayInputSchema.safeParse({ ...base, endsAt: new Date(Date.now() - 1000) }).success).toBe(false);
    expect(giveawayInputSchema.safeParse({ ...base, endsAt: new Date(Date.now() + 100 * 86_400_000) }).success).toBe(false);
  });
});

describe('Giveaway: Teilnahmebedingungen', () => {
  const now = Date.now();
  const member = (o: { roles?: string[]; joinedDaysAgo?: number; accountDaysAgo?: number; pending?: boolean; bot?: boolean }) =>
    ({
      user: { bot: !!o.bot, createdTimestamp: now - (o.accountDaysAgo ?? 1000) * 86_400_000 },
      roles: { cache: { has: (id: string) => (o.roles ?? []).includes(id) } },
      joinedTimestamp: now - (o.joinedDaysAgo ?? 100) * 86_400_000,
      pending: !!o.pending,
    }) as never;
  const rules = { requiredRoleIds: [] as string[], blockedRoleIds: [] as string[], minMemberDays: 0, minAccountDays: 0, requireVerified: false };
  it('prüft Rollen, Ausschlüsse, Mitgliedschaftsdauer, Kontoalter und Verifizierung', () => {
    expect(checkEligibility(rules, member({}), now)).toBeNull();
    expect(checkEligibility({ ...rules, requiredRoleIds: ['r1'] }, member({}), now)).toMatch(/Rollen/);
    expect(checkEligibility({ ...rules, requiredRoleIds: ['r1'] }, member({ roles: ['r1'] }), now)).toBeNull();
    expect(checkEligibility({ ...rules, blockedRoleIds: ['x'] }, member({ roles: ['x'] }), now)).toMatch(/ausgeschlossen/);
    expect(checkEligibility({ ...rules, minMemberDays: 30 }, member({ joinedDaysAgo: 5 }), now)).toMatch(/30 Tage/);
    expect(checkEligibility({ ...rules, minAccountDays: 30 }, member({ accountDaysAgo: 3 }), now)).toMatch(/Konto/);
    expect(checkEligibility({ ...rules, requireVerified: true }, member({ pending: true }), now)).toMatch(/regeln/i);
    expect(checkEligibility(rules, member({ bot: true }), now)).toMatch(/Bots/);
  });
});
