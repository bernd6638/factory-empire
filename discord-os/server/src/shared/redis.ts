import Redis from 'ioredis';
import { env } from './env';
import { childLogger } from './logger';

const log = childLogger('redis');

/** Erstellt eine neue Redis-Verbindung (Pub/Sub benötigt jeweils eigene Verbindungen). */
export function createRedis(name: string): Redis {
  const client = new Redis(env().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: `discord-os:${name}`,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  client.on('error', (err) => log.warn({ err: err.message, name }, 'Redis-Fehler'));
  client.on('ready', () => log.debug({ name }, 'Redis verbunden'));
  return client;
}

let shared: Redis | null = null;
/** Gemeinsame Verbindung für normale Befehle (Cache, Zähler, Heartbeat). */
export function redis(): Redis {
  if (!shared) shared = createRedis('main');
  return shared;
}
