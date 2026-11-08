/**
 * Discord OS – Einstiegspunkt.
 *
 *   node dist/index.js        → Bot + API/Dashboard in einem Prozess
 *   node dist/index.js bot    → nur der Discord-Bot
 *   node dist/index.js api    → nur API + Dashboard
 *
 * Bot und API kommunizieren immer über Redis und können daher auch getrennt betrieben werden.
 */
import { env } from './shared/env';
import { logger } from './shared/logger';
import { prisma } from './shared/prisma';
import { redis } from './shared/redis';

type Stopper = () => Promise<void>;

async function main() {
  env(); // Konfiguration früh validieren
  const role = (process.argv[2] ?? 'all').toLowerCase();
  if (!['all', 'bot', 'api'].includes(role)) {
    logger.error(`Unbekannte Rolle "${role}". Erlaubt: all | bot | api`);
    process.exit(1);
  }

  await prisma.$connect();
  await redis().ping();
  logger.info({ role }, 'Discord OS startet');

  const stoppers: Stopper[] = [];
  if (role === 'all' || role === 'api') {
    const { startApi } = await import('./api/index');
    stoppers.push(await startApi());
  }
  if (role === 'all' || role === 'bot') {
    const { startBot } = await import('./bot/index');
    stoppers.push(await startBot());
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Beende Discord OS …');
    const force = setTimeout(() => process.exit(1), 10_000);
    for (const stop of stoppers.reverse()) await stop().catch((err) => logger.error({ err }, 'Fehler beim Beenden'));
    await prisma.$disconnect().catch(() => undefined);
    await redis().quit().catch(() => undefined);
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

process.on('unhandledRejection', (err) => logger.error({ err }, 'Unbehandelte Promise-Ablehnung'));
process.on('uncaughtException', (err) => logger.error({ err }, 'Unbehandelte Ausnahme'));

main().catch((err) => {
  logger.fatal({ err }, 'Start fehlgeschlagen');
  process.exit(1);
});
