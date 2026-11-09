import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

/** Sucht eine .env-Datei im aktuellen Verzeichnis und bis zu drei Ebenen darüber. */
function loadDotenv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const file = path.join(dir, '.env');
    if (fs.existsSync(file)) {
      dotenv.config({ path: file, quiet: true } as dotenv.DotenvConfigOptions);
      return;
    }
    dir = path.dirname(dir);
  }
}
loadDotenv();

const bool = z
  .string()
  .optional()
  .transform((v) => ['1', 'true', 'yes', 'on'].includes((v ?? '').toLowerCase()));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL fehlt'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN fehlt'),
  DISCORD_CLIENT_ID: z.string().regex(/^\d{15,22}$/, 'DISCORD_CLIENT_ID muss eine Discord-ID sein'),
  DISCORD_CLIENT_SECRET: z.string().min(1, 'DISCORD_CLIENT_SECRET fehlt'),
  DEV_GUILD_ID: z.string().optional().transform((v) => (v ? v : undefined)),
  ENABLE_PRESENCE_INTENT: bool,
  PUBLIC_URL: z.string().url().default('http://localhost:3001').transform((v) => v.replace(/\/+$/, '')),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  TRUST_PROXY: bool,
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET muss mindestens 32 Zeichen lang sein'),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY muss aus 64 Hex-Zeichen bestehen'),
  BOT_OWNER_IDS: z
    .string()
    .optional()
    .transform((v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  /** Lokale KI-Dienste für den Sprach-Bot (optional) */
  VOICE_AI_URL: z.string().url().default('http://localhost:8000').transform((v) => v.replace(/\/+$/, '')),
  OLLAMA_URL: z.string().url().default('http://localhost:11434').transform((v) => v.replace(/\/+$/, '')),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Liest und validiert alle Umgebungsvariablen (einmalig, danach gecacht). */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`);
    // eslint-disable-next-line no-console
    console.error(`\n[Discord OS] Ungültige Konfiguration (.env):\n${lines.join('\n')}\n\nSiehe .env.example und docs/INSTALLATION.md\n`);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}
