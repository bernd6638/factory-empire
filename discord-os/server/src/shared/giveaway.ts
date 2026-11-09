import { createHash, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { snowflake } from './modules';

/**
 * Nachvollziehbare, manipulationsgeschützte Gewinnerauswahl (Commit-Reveal):
 *
 *  1. Bei Erstellung wird ein geheimer Zufallswert (Seed) erzeugt und nur sein SHA-256-Hash veröffentlicht.
 *  2. Nach Ende wird für jeden Teilnehmer HMAC-SHA256(seed, userId) berechnet und aufsteigend sortiert.
 *     Die ersten N sind die Gewinner, die folgenden die Ersatzgewinner (Reihenfolge für Rerolls).
 *  3. Der Seed wird veröffentlicht – jeder kann prüfen, dass sha256(seed) dem vorab gezeigten Hash
 *     entspricht und die Reihenfolge exakt reproduzieren. Der Seed stand vor der ersten Teilnahme fest,
 *     daher kann niemand (auch nicht der Betreiber) das Ergebnis nachträglich steuern.
 */

export function createSeed(): { seed: string; seedHash: string } {
  const seed = randomBytes(32).toString('hex');
  return { seed, seedHash: hashSeed(seed) };
}

export function hashSeed(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

export function ticket(seed: string, userId: string): string {
  return createHmac('sha256', seed).update(userId).digest('hex');
}

/** Vollständige Ziehungsreihenfolge (deterministisch, unabhängig von der Eingabereihenfolge). */
export function computeDrawOrder(seed: string, userIds: string[]): string[] {
  return [...new Set(userIds)]
    .map((id) => ({ id, t: ticket(seed, id) }))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
    .map((x) => x.id);
}

export const giveawayInputSchema = z
  .object({
    channelId: snowflake,
    prize: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    imageUrl: z.string().url().max(500).nullable().optional().or(z.literal('').transform(() => null)),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#8b5cf6'),
    winnerCount: z.number().int().min(1).max(50).default(1),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date(),
    requiredRoleIds: z.array(snowflake).max(20).default(() => []),
    blockedRoleIds: z.array(snowflake).max(20).default(() => []),
    minMemberDays: z.number().int().min(0).max(3650).default(0),
    minAccountDays: z.number().int().min(0).max(3650).default(0),
    requireVerified: z.boolean().default(false),
    maxEntries: z.number().int().min(1).max(1_000_000).nullable().optional(),
    reminderMinutes: z.number().int().min(0).max(10080).default(60),
  })
  .refine((g) => g.endsAt.getTime() > (g.startsAt?.getTime() ?? Date.now()) + 60_000, { message: 'Das Ende muss mindestens 1 Minute nach dem Start liegen.', path: ['endsAt'] })
  .refine((g) => g.endsAt.getTime() - (g.startsAt?.getTime() ?? Date.now()) <= 90 * 86_400_000, { message: 'Ein Gewinnspiel darf höchstens 90 Tage laufen.', path: ['endsAt'] });
export type GiveawayInput = z.infer<typeof giveawayInputSchema>;
