#!/usr/bin/env node
/**
 * Discord OS – Ersteinrichtung (Windows, Linux, macOS)
 *  1. Prüft die Node.js-Version
 *  2. Legt .env aus .env.example an und erzeugt sichere Schlüssel
 *  3. Installiert Abhängigkeiten
 *  4. Erstellt/aktualisiert die Datenbank (Migrationen)
 *  5. Baut Backend und Frontend
 */
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
const c = { g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, b: (s) => `\x1b[36m${s}\x1b[0m` };
const step = (n, t) => console.log(`\n${c.b(`[${n}/5]`)} ${t}`);
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit', shell: true });

console.log(c.b('\n╔══════════════════════════════════╗\n║      Discord OS – Einrichtung     ║\n╚══════════════════════════════════╝'));

step(1, 'Node.js prüfen');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 11)) {
  console.log(c.r(`Node.js ${process.versions.node} ist zu alt. Benötigt wird Version 20.11 oder neuer (empfohlen: 22 LTS).`));
  process.exit(1);
}
console.log(c.g(`✓ Node.js ${process.versions.node}`));

step(2, 'Konfiguration (.env)');
if (!fs.existsSync(envFile)) {
  fs.copyFileSync(path.join(root, '.env.example'), envFile);
  console.log(c.g('✓ .env aus .env.example erstellt'));
}
let env = fs.readFileSync(envFile, 'utf8');
const setIfEmpty = (key, value) => {
  const re = new RegExp(`^${key}=(.*)$`, 'm');
  const m = env.match(re);
  if (!m || m[1].trim() === '') {
    env = m ? env.replace(re, `${key}=${value}`) : `${env}\n${key}=${value}\n`;
    console.log(c.g(`✓ ${key} wurde sicher erzeugt`));
  }
};
setIfEmpty('SESSION_SECRET', randomBytes(48).toString('hex'));
setIfEmpty('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
fs.writeFileSync(envFile, env);
const missing = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'].filter((k) => {
  const v = env.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
  return !v || v.startsWith('dein');
});
if (missing.length) console.log(c.y(`! Bitte in .env eintragen: ${missing.join(', ')} (siehe docs/INSTALLATION.md)`));

step(3, 'Abhängigkeiten installieren');
run('npm install');

step(4, 'Datenbank einrichten');
try {
  run('npm run db:deploy');
  console.log(c.g('✓ Datenbank ist aktuell'));
} catch {
  console.log(c.y('! Datenbank nicht erreichbar. Läuft PostgreSQL? (z. B. "docker compose up -d")'));
  console.log(c.y('  Die Migrationen werden beim nächsten Start automatisch ausgeführt.'));
}

step(5, 'Anwendung bauen');
run('npm run build');

console.log(c.g('\n✓ Einrichtung abgeschlossen!'));
console.log(`  Starten:  ${c.b('npm start')}  (Windows: ${c.b('scripts\\windows\\start.bat')})`);
console.log(`  Dashboard: ${env.match(/^PUBLIC_URL=(.*)$/m)?.[1] ?? 'http://localhost:3001'}\n`);
