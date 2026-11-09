import { describe, expect, it } from 'vitest';
import { levelFromXp, totalXpForLevel, xpForNextLevel } from '../src/shared/leveling';
import { formatDuration, parseDuration } from '../src/shared/duration';
import { renderTemplate } from '../src/shared/template';
import { decrypt, encrypt } from '../src/shared/crypto';
import { defaultModuleConfig, parseModuleConfig, MODULE_KEYS, MODULES } from '../src/shared/modules';
import { automationInputSchema, matchesMessage, nextCronRun } from '../src/shared/automation';
import { hasPerm, PERM } from '../src/shared/access';

describe('Levelkurven', () => {
  const standard = defaultModuleConfig('leveling').curve;
  it('Standardkurve entspricht 5l² + 50l + 100', () => {
    expect(xpForNextLevel(0, standard)).toBe(100);
    expect(xpForNextLevel(1, standard)).toBe(155);
    expect(totalXpForLevel(2, standard)).toBe(255);
  });
  it('berechnet Level und Fortschritt', () => {
    const p = levelFromXp(300, standard);
    expect(p.level).toBe(2);
    expect(p.current).toBe(45);
    expect(p.needed).toBe(220);
  });
  it('lineare und exponentielle Kurven', () => {
    const linear = { type: 'linear' as const, base: 100, step: 50, growth: 1.15 };
    expect(xpForNextLevel(2, linear)).toBe(200);
    const exp = { type: 'exponential' as const, base: 100, step: 0, growth: 2 };
    expect(xpForNextLevel(3, exp)).toBe(800);
    expect(levelFromXp(totalXpForLevel(10, linear), linear).level).toBe(10);
  });
});

describe('Dauer', () => {
  it('parst gängige Formate', () => {
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('2h30m')).toBe(9_000_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('15')).toBe(900_000);
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('10x')).toBeNull();
  });
  it('formatiert lesbar', () => {
    expect(formatDuration(90 * 60_000)).toBe('1 Std 30 Min');
  });
});

describe('Templates', () => {
  it('ersetzt bekannte Platzhalter und lässt unbekannte stehen', () => {
    expect(renderTemplate('Hi {user} auf {server} {x}', { user: '<@1>', server: 'Test' })).toBe('Hi <@1> auf Test {x}');
  });
});

describe('Verschlüsselung', () => {
  it('AES-256-GCM Hin- und Rückweg', () => {
    const key = 'a'.repeat(64);
    const enc = encrypt('geheim', key);
    expect(enc).not.toContain('geheim');
    expect(decrypt(enc, key)).toBe('geheim');
    expect(() => decrypt(enc.replace(/.$/, enc.endsWith('A') ? 'B' : 'A'), key)).toThrow();
  });
});

describe('Modul-Konfiguration', () => {
  it('jedes Modul hat gültige Standardwerte', () => {
    for (const key of MODULE_KEYS) {
      const cfg = defaultModuleConfig(key);
      expect(MODULES[key].schema.safeParse(cfg).success).toBe(true);
    }
  });
  it('füllt fehlende Felder auf und verwirft ungültige', () => {
    const cfg = parseModuleConfig('automod', { spam: { maxMessages: 9999 }, links: { enabled: true } });
    expect(cfg.spam.maxMessages).toBe(6); // ungültig → Standard
    expect(cfg.links.enabled).toBe(true);
    expect(cfg.raid.joinThreshold).toBe(10);
  });
  it('Standard-Arrays werden nicht zwischen Aufrufen geteilt', () => {
    const a = defaultModuleConfig('moderation');
    a.protectedRoleIds.push('123456789012345678');
    expect(defaultModuleConfig('moderation').protectedRoleIds).toEqual([]);
  });
});

describe('Automatisierungen', () => {
  it('validiert Regeln inkl. Auslöser-Konfiguration', () => {
    const ok = automationInputSchema.safeParse({ name: 'Hallo', trigger: 'MESSAGE_CONTAINS', triggerConfig: { keywords: ['hallo'] }, actions: [{ type: 'REPLY', content: 'Hi!' }] });
    expect(ok.success).toBe(true);
    const bad = automationInputSchema.safeParse({ name: 'X', trigger: 'ROLE_ADDED', triggerConfig: {}, actions: [{ type: 'REPLY', content: 'Hi' }] });
    expect(bad.success).toBe(false);
    const badRegex = automationInputSchema.safeParse({ name: 'X', trigger: 'MESSAGE_CONTAINS', triggerConfig: { keywords: ['(['], matchMode: 'regex' }, actions: [{ type: 'REPLY', content: 'Hi' }] });
    expect(badRegex.success).toBe(false);
  });
  it('Umfrage-Aktion mit Quartals-Zeitplan', () => {
    const rule = automationInputSchema.safeParse({
      name: 'RAD-Abstimmung',
      trigger: 'SCHEDULE',
      triggerConfig: { cron: '0 18 1 1,4,7,10 *' },
      actions: [{ type: 'SEND_POLL', channelId: '123456789012345678', question: 'Wer möchte in den RAD?', answers: [{ text: 'Ich', emoji: '✅' }, { text: 'Ich nicht', emoji: '❌' }] }],
    });
    expect(rule.success).toBe(true);
    const tooFew = automationInputSchema.safeParse({ name: 'X', trigger: 'SCHEDULE', triggerConfig: { cron: '0 18 1 1,4,7,10 *' }, actions: [{ type: 'SEND_POLL', question: 'Q', answers: [{ text: 'Nur eine' }] }] });
    expect(tooFew.success).toBe(false);
    // Vom 15. Februar aus ist der nächste Termin der 1. April 18:00 Berliner Zeit (= 16:00 UTC, Sommerzeit)
    expect(nextCronRun('0 18 1 1,4,7,10 *', 'Europe/Berlin', new Date('2026-02-15T12:00:00Z'))?.toISOString()).toBe('2026-04-01T16:00:00.000Z');
  });
  it('vergleicht Nachrichten', () => {
    const base = { keywords: ['hilfe'], caseSensitive: false, channelIds: [] };
    expect(matchesMessage('Ich brauche HILFE', { ...base, matchMode: 'contains' })).toBe(true);
    expect(matchesMessage('hilfe', { ...base, matchMode: 'exact' })).toBe(true);
    expect(matchesMessage('hilfe bitte', { ...base, matchMode: 'exact' })).toBe(false);
    expect(matchesMessage('test 123', { ...base, keywords: ['\\d{3}'], matchMode: 'regex' })).toBe(true);
  });
  it('berechnet Cron-Zeitpunkte mit Zeitzone', () => {
    const next = nextCronRun('0 9 * * *', 'Europe/Berlin', new Date('2026-01-15T10:00:00Z'));
    expect(next?.toISOString()).toBe('2026-01-16T08:00:00.000Z');
    expect(nextCronRun('kein cron', 'UTC')).toBeNull();
  });
});

describe('Berechtigungen', () => {
  it('Administrator impliziert alle Rechte', () => {
    expect(hasPerm(PERM.ADMINISTRATOR.toString(), PERM.MANAGE_GUILD)).toBe(true);
    expect(hasPerm((PERM.MANAGE_GUILD | PERM.KICK_MEMBERS).toString(), PERM.MANAGE_GUILD)).toBe(true);
    expect(hasPerm(PERM.KICK_MEMBERS.toString(), PERM.MANAGE_GUILD)).toBe(false);
  });
});
