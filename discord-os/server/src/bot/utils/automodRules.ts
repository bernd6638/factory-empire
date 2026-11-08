/**
 * Reine Prüfregeln der Auto-Moderation (ohne Discord-Abhängigkeit, daher gut testbar).
 */

const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg|discord\.me)\/([a-z0-9-]{2,32})/gi;
const URL_RE = /\bhttps?:\/\/([^\s/$.?#][^\s/]*)[^\s]*/gi;
const BARE_DOMAIN_RE = /\b((?:[a-z0-9-]+\.)+(?:com|net|org|de|io|gg|ru|xyz|me|tv|co|info|biz|app|dev|link|ly|to|sh|cc|eu|uk|fr|nl|at|ch))\b(?:\/\S*)?/gi;

/** Liefert alle Einladungs-Codes einer Nachricht. */
export function findInviteCodes(content: string): string[] {
  const codes: string[] = [];
  for (const m of content.matchAll(INVITE_RE)) codes.push(m[1]!.toLowerCase());
  return codes;
}

/** Liefert alle Domains (Links), die in einer Nachricht vorkommen. */
export function findDomains(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(URL_RE)) out.add(normalizeDomain(m[1]!));
  for (const m of content.matchAll(BARE_DOMAIN_RE)) out.add(normalizeDomain(m[1]!));
  return [...out];
}

function normalizeDomain(d: string): string {
  return d.toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
}

/** true, wenn die Domain (oder eine Subdomain davon) erlaubt ist. */
export function isDomainAllowed(domain: string, allowed: string[]): boolean {
  const d = normalizeDomain(domain);
  return allowed.some((a) => {
    const n = normalizeDomain(a.trim());
    return n.length > 0 && (d === n || d.endsWith(`.${n}`));
  });
}

export function findForbiddenLinks(content: string, allowed: string[]): string[] {
  // Discord-Einladungen werden separat behandelt
  const withoutInvites = content.replace(INVITE_RE, ' ');
  return findDomains(withoutInvites).filter((d) => !isDomainAllowed(d, allowed));
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };

/** Normalisiert Text gegen einfache Umgehungen (Leetspeak, Wiederholungen, Akzente). */
export function normalizeForFilter(content: string): string {
  return content
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[013457@$!]/g, (c) => LEET[c] ?? c)
    .replace(/(.)\1{2,}/g, '$1$1');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Baut aus Wortliste ("*" = Platzhalter) und Regex-Liste einen Matcher. */
export function compileWordFilter(words: string[], regexes: string[]): (content: string) => string | null {
  const patterns: RegExp[] = [];
  for (const w of words) {
    const word = w.trim().toLowerCase();
    if (!word) continue;
    const body = word.split('*').map(escapeRegex).join('\\S*');
    patterns.push(new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu'));
  }
  for (const r of regexes) {
    try {
      patterns.push(new RegExp(r, 'iu'));
    } catch {
      /* ungültige Regex wird ignoriert */
    }
  }
  return (content: string) => {
    const normalized = normalizeForFilter(content);
    // Zusätzlich jede Buchstabenwiederholung auf einen Buchstaben reduzieren ("iiidiot" → "idiot")
    const variants = [content.toLowerCase(), normalized, normalized.replace(/(.)\1+/g, '$1')];
    for (const p of patterns) for (const v of variants) {
      const m = v.match(p);
      if (m) return m[0].trim();
    }
    return null;
  };
}

/** Prozentualer Anteil an Großbuchstaben (nur Buchstaben gezählt). */
export function capsPercent(content: string): { letters: number; percent: number } {
  const letters = content.replace(/<a?:\w+:\d+>|<[@#&!]+\d+>|https?:\/\/\S+/g, '').match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return { letters: 0, percent: 0 };
  const upper = letters.filter((c) => c !== c.toLowerCase() && c === c.toUpperCase()).length;
  return { letters: letters.length, percent: Math.round((upper / letters.length) * 100) };
}

/**
 * Gleitendes Zeitfenster pro Schlüssel (z. B. guild:user) für Spam- und Raid-Erkennung.
 */
export class SlidingWindow {
  private hits = new Map<string, { t: number; v: string }[]>();

  constructor(private maxKeys = 50_000) {}

  /** Fügt einen Treffer hinzu und gibt alle Treffer innerhalb des Fensters zurück. */
  push(key: string, windowMs: number, value = '', now = Date.now()): { t: number; v: string }[] {
    const list = (this.hits.get(key) ?? []).filter((h) => now - h.t <= windowMs);
    list.push({ t: now, v: value });
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) this.prune(windowMs, now);
    return list;
  }

  clear(key: string) {
    this.hits.delete(key);
  }

  prune(windowMs: number, now = Date.now()) {
    for (const [k, list] of this.hits) {
      const fresh = list.filter((h) => now - h.t <= windowMs);
      if (fresh.length === 0) this.hits.delete(k);
      else this.hits.set(k, fresh);
    }
  }
}
