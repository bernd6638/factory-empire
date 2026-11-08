const nf = new Intl.NumberFormat('de-DE');
const cf = new Intl.NumberFormat('de-DE', { notation: 'compact', maximumFractionDigits: 1 });

export const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : nf.format(v));
export const compact = (v: number | null | undefined) => (v === null || v === undefined ? '—' : cf.format(v));

export function dateTime(v: string | Date | null | undefined) {
  if (!v) return '—';
  return new Date(v).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

export function date(v: string | Date | null | undefined) {
  if (!v) return '—';
  return new Date(v).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function shortDay(v: string) {
  return new Date(v).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

const rtf = new Intl.RelativeTimeFormat('de-DE', { numeric: 'auto' });
export function relative(v: string | Date | null | undefined) {
  if (!v) return '—';
  const diff = (new Date(v).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), 'month');
  return rtf.format(Math.round(diff / (86400 * 365)), 'year');
}

export function duration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d} T ${h} Std`;
  if (h) return `${h} Std ${m} Min`;
  if (m) return `${m} Min`;
  return `${Math.round(seconds)} Sek`;
}

export function avatarUrl(userId: string, avatar: string | null | undefined) {
  if (avatar?.startsWith('http')) return avatar;
  if (avatar) return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png?size=64`;
  try {
    return `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(userId) >> 22n) % 6n)}.png`;
  } catch {
    return 'https://cdn.discordapp.com/embed/avatars/0.png';
  }
}

export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}
