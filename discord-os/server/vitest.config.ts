import { defineConfig } from 'vitest/config';
// Integrationstests teilen sich Datenbank und Redis – daher Dateien nacheinander ausführen.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node', fileParallelism: false } });
