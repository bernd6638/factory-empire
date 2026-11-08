import { describe, expect, it } from 'vitest';
import { SlidingWindow, capsPercent, compileWordFilter, findForbiddenLinks, findInviteCodes, isDomainAllowed } from '../src/bot/utils/automodRules';

describe('Auto-Moderation: Einladungen', () => {
  it('erkennt Discord-Einladungen in verschiedenen Formen', () => {
    expect(findInviteCodes('komm auf discord.gg/abc123 !')).toEqual(['abc123']);
    expect(findInviteCodes('https://discord.com/invite/XyZ-9')).toEqual(['xyz-9']);
    expect(findInviteCodes('https://discordapp.com/invite/test')).toEqual(['test']);
    expect(findInviteCodes('normaler Text ohne Link')).toEqual([]);
  });
});

describe('Auto-Moderation: Links', () => {
  it('erlaubt Domains inkl. Subdomains', () => {
    expect(isDomainAllowed('www.youtube.com', ['youtube.com'])).toBe(true);
    expect(isDomainAllowed('music.youtube.com', ['youtube.com'])).toBe(true);
    expect(isDomainAllowed('youtube.com.evil.ru', ['youtube.com'])).toBe(false);
  });
  it('findet unerlaubte Links, ignoriert Einladungen', () => {
    expect(findForbiddenLinks('schau https://evil.ru/x und https://youtube.com/watch', ['youtube.com'])).toEqual(['evil.ru']);
    expect(findForbiddenLinks('discord.gg/abc', [])).toEqual([]);
    expect(findForbiddenLinks('geh auf free-nitro.xyz jetzt', [])).toEqual(['free-nitro.xyz']);
  });
});

describe('Auto-Moderation: Wortfilter', () => {
  const match = compileWordFilter(['idiot', 'bl*d'], ['sp[a@]m+er']);
  it('findet ganze Wörter und Platzhalter', () => {
    expect(match('du bist ein Idiot!')).toBe('idiot');
    expect(match('das ist blöd')).not.toBeNull();
    expect(match('spammmer hier')).not.toBeNull();
  });
  it('erkennt einfache Umgehungen (Leetspeak, Wiederholungen)', () => {
    expect(match('du 1d10t')).not.toBeNull();
    expect(match('iiiidiot')).not.toBeNull();
  });
  it('liefert keine Treffer bei harmlosen Wörtern', () => {
    expect(match('Idiotensicher ist dieses Tool')).toBeNull();
    expect(match('Hallo zusammen')).toBeNull();
  });
  it('ignoriert ungültige reguläre Ausdrücke', () => {
    expect(() => compileWordFilter([], ['(['])).not.toThrow();
  });
});

describe('Auto-Moderation: Großschreibung', () => {
  it('berechnet den Anteil an Großbuchstaben', () => {
    expect(capsPercent('HALLO WELT').percent).toBe(100);
    expect(capsPercent('Hallo Welt').percent).toBe(22); // 2 von 9 Buchstaben
    expect(capsPercent('1234 !!!').letters).toBe(0);
  });
});

describe('SlidingWindow', () => {
  it('zählt nur Treffer im Zeitfenster', () => {
    const w = new SlidingWindow();
    w.push('a', 1000, 'x', 0);
    w.push('a', 1000, 'x', 500);
    expect(w.push('a', 1000, 'x', 1200)).toHaveLength(2);
    w.clear('a');
    expect(w.push('a', 1000, 'y', 1300)).toHaveLength(1);
  });
});
