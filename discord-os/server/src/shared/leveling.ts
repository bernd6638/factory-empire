import type { LevelCurve } from './modules';

/** XP, die benötigt werden, um von `level` auf `level + 1` zu kommen. */
export function xpForNextLevel(level: number, curve: LevelCurve): number {
  switch (curve.type) {
    case 'linear':
      return Math.round(curve.base + curve.step * level);
    case 'exponential':
      return Math.round(curve.base * Math.pow(curve.growth, level));
    case 'standard':
    default:
      // Bewährte Kurve: 5·l² + 50·l + 100 (skaliert über base)
      return Math.round((5 * level * level + 50 * level + 100) * (curve.base / 100));
  }
}

/** Gesamt-XP, die für das Erreichen von `level` nötig sind. */
export function totalXpForLevel(level: number, curve: LevelCurve): number {
  let total = 0;
  for (let l = 0; l < level; l++) total += xpForNextLevel(l, curve);
  return total;
}

export interface LevelProgress {
  level: number;
  /** XP innerhalb des aktuellen Levels */
  current: number;
  /** XP, die das aktuelle Level insgesamt benötigt */
  needed: number;
  totalXp: number;
  percent: number;
}

export function levelFromXp(totalXp: number, curve: LevelCurve, maxLevel = 1000): LevelProgress {
  let level = 0;
  let remaining = Math.max(0, totalXp);
  while (level < maxLevel) {
    const need = xpForNextLevel(level, curve);
    if (need <= 0 || remaining < need) break;
    remaining -= need;
    level++;
  }
  const needed = xpForNextLevel(level, curve);
  return { level, current: remaining, needed, totalXp, percent: needed > 0 ? Math.min(100, (remaining / needed) * 100) : 100 };
}
