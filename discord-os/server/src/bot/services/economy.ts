import { Prisma, type TransactionType } from '@prisma/client';
import { prisma } from '../../shared/prisma';
import { RpcError } from '../../shared/bus';
import type { ModuleConfig } from '../../shared/modules';

/**
 * Datenzugriff der virtuellen Wirtschaft. Alle Geldbewegungen laufen über atomare
 * Datenbank-Updates mit Bedingungen, damit kein negativer Kontostand entstehen kann.
 */

export async function getAccount(guildId: string, userId: string, cfg: ModuleConfig<'economy'>) {
  return prisma.economyAccount.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId, wallet: cfg.startingBalance },
    update: {},
    include: { job: true, company: true },
  });
}

/** Schreibt Geld gut (Wallet) und protokolliert die Transaktion. */
export async function credit(guildId: string, userId: string, amount: number, type: TransactionType, cfg: ModuleConfig<'economy'>, note?: string) {
  if (amount <= 0) return;
  await getAccount(guildId, userId, cfg);
  await prisma.$transaction([
    prisma.economyAccount.update({
      where: { guildId_userId: { guildId, userId } },
      data: { wallet: { increment: amount }, totalEarned: { increment: amount } },
    }),
    prisma.transaction.create({ data: { guildId, type, toUserId: userId, amount, note } }),
  ]);
}

/** Bucht Geld vom Wallet ab – schlägt fehl, wenn das Guthaben nicht reicht. */
export async function debit(tx: Prisma.TransactionClient, guildId: string, userId: string, amount: number) {
  const res = await tx.economyAccount.updateMany({
    where: { guildId, userId, wallet: { gte: amount } },
    data: { wallet: { decrement: amount } },
  });
  if (res.count === 0) throw new RpcError('INSUFFICIENT_FUNDS', 'Nicht genügend Guthaben im Wallet.');
}

export function fmt(amount: number, cfg: ModuleConfig<'economy'>) {
  return `${cfg.currencySymbol} ${amount.toLocaleString('de-DE')} ${cfg.currencyName}`;
}

export function randomInt(min: number, max: number) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}
