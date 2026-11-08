import { Prisma } from '@prisma/client';
import { prisma } from '../../shared/prisma';
import { MODULES, MODULE_KEYS, parseModuleConfig, type ModuleConfig, type ModuleKey } from '../../shared/modules';

interface Entry<K extends ModuleKey = ModuleKey> {
  enabled: boolean;
  config: ModuleConfig<K>;
  loadedAt: number;
}

const TTL_MS = 5 * 60_000;

/**
 * Lädt Modul-Einstellungen aus der Datenbank und hält sie im Speicher.
 * Änderungen im Dashboard invalidieren den Cache über den Bus sofort.
 */
export class ConfigService {
  private cache = new Map<string, Entry>();
  private inflight = new Map<string, Promise<Entry>>();

  private key(guildId: string, module: ModuleKey) {
    return `${guildId}:${module}`;
  }

  async get<K extends ModuleKey>(guildId: string, module: K): Promise<Entry<K>> {
    const k = this.key(guildId, module);
    const hit = this.cache.get(k);
    if (hit && Date.now() - hit.loadedAt < TTL_MS) return hit as unknown as Entry<K>;
    let p = this.inflight.get(k);
    if (!p) {
      p = this.load(guildId, module).finally(() => this.inflight.delete(k));
      this.inflight.set(k, p);
    }
    return (await p) as unknown as Entry<K>;
  }

  async isEnabled(guildId: string, module: ModuleKey): Promise<boolean> {
    return (await this.get(guildId, module)).enabled;
  }

  /** Gibt die Konfiguration nur zurück, wenn das Modul aktiv ist. */
  async ifEnabled<K extends ModuleKey>(guildId: string, module: K): Promise<ModuleConfig<K> | null> {
    const e = await this.get(guildId, module);
    return e.enabled ? e.config : null;
  }

  private async load<K extends ModuleKey>(guildId: string, module: K): Promise<Entry> {
    let row = await prisma.guildModule.findUnique({ where: { guildId_moduleKey: { guildId, moduleKey: module } } });
    if (!row) {
      const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { id: true } });
      if (guild) {
        row = await prisma.guildModule.upsert({
          where: { guildId_moduleKey: { guildId, moduleKey: module } },
          create: { guildId, moduleKey: module, enabled: MODULES[module].defaultEnabled, config: {} },
          update: {},
        });
      }
    }
    const entry: Entry = {
      enabled: row?.enabled ?? MODULES[module].defaultEnabled,
      config: parseModuleConfig(module, row?.config ?? {}),
      loadedAt: Date.now(),
    };
    this.cache.set(this.key(guildId, module), entry);
    return entry;
  }

  /** Teilweise Aktualisierung aus dem Bot heraus (z. B. Panel-Nachricht-ID speichern). */
  async patch<K extends ModuleKey>(guildId: string, module: K, mutate: (cfg: ModuleConfig<K>) => void) {
    const current = await this.get(guildId, module);
    const next = structuredClone(current.config);
    mutate(next);
    await prisma.guildModule.upsert({
      where: { guildId_moduleKey: { guildId, moduleKey: module } },
      create: { guildId, moduleKey: module, enabled: current.enabled, config: next as Prisma.InputJsonValue },
      update: { config: next as Prisma.InputJsonValue },
    });
    this.invalidate(guildId, module);
  }

  invalidate(guildId: string, module: string) {
    if (module === '*') {
      for (const m of MODULE_KEYS) this.cache.delete(this.key(guildId, m));
    } else {
      this.cache.delete(`${guildId}:${module}`);
    }
  }
}
