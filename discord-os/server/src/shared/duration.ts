/** Wandelt "10m", "2h30m", "1d", "45s", "1w" in Millisekunden um. Gibt null bei ungültiger Eingabe zurück. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s) * 60_000; // reine Zahl = Minuten
  const re = /(\d+)(w|d|h|m|min|s|sek|sec|std|t)/g;
  const units: Record<string, number> = { w: 604_800_000, d: 86_400_000, t: 86_400_000, h: 3_600_000, std: 3_600_000, m: 60_000, min: 60_000, s: 1000, sek: 1000, sec: 1000 };
  let total = 0;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    total += Number(m[1]) * units[m[2]!]!;
    consumed += m[0].length;
  }
  return consumed === s.length && total > 0 ? total : null;
}

export function formatDuration(ms: number): string {
  const parts: string[] = [];
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  if (d) parts.push(`${d} T`);
  if (h) parts.push(`${h} Std`);
  if (m) parts.push(`${m} Min`);
  if (s && !d && !h) parts.push(`${s} Sek`);
  return parts.join(' ') || '0 Sek';
}

/** Datum auf UTC-Tagesanfang normalisieren (für @db.Date). */
export function dayStart(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function hourStart(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()));
}
