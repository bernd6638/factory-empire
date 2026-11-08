import {
  Events,
  Guild,
  REST,
  Routes,
  type ClientEvents,
  type Interaction,
  MessageFlags,
} from 'discord.js';
import { env } from '../../shared/env';
import { redis } from '../../shared/redis';
import { childLogger } from '../../shared/logger';
import { MODULES, isModuleKey } from '../../shared/modules';
import type { BotContext, BotModule, InternalEvents, ModuleId, SlashCommand, ComponentHandler } from './types';
import { failure } from '../utils/embeds';
import { RpcError } from '../../shared/bus';

const log = childLogger('modules');

export const MODULE_ERRORS_KEY = 'dos:module:errors';
export const MODULE_LASTERROR_KEY = 'dos:module:lasterror';

/**
 * Plugin-System des Bots.
 *
 *  • Verteilt Discord-Events an alle Module – aber nur, wenn das Modul auf dem jeweiligen Server aktiv ist.
 *  • Jeder Handler läuft isoliert: ein Fehler in einem Modul beeinträchtigt keine anderen Module.
 *  • Fehler werden pro Modul in Redis gezählt und im Dashboard (Plugins) angezeigt.
 */
export class ModuleManager {
  private modules: BotModule[] = [];
  private commands = new Map<string, { module: ModuleId; command: SlashCommand }>();
  private components = new Map<string, { module: ModuleId; handler: ComponentHandler }>();
  private rpc = new Map<string, { module: ModuleId; fn: (params: any, ctx: BotContext) => Promise<unknown> }>();
  private timers: NodeJS.Timeout[] = [];

  constructor(private ctx: BotContext) {}

  register(...modules: BotModule[]) {
    for (const m of modules) {
      this.modules.push(m);
      for (const c of m.commands ?? []) this.commands.set(c.data.name, { module: m.id, command: c });
      for (const h of m.components ?? []) this.components.set(h.prefix, { module: m.id, handler: h });
      for (const [name, fn] of Object.entries(m.rpc ?? {})) this.rpc.set(name, { module: m.id, fn });
    }
  }

  /** Bindet alle Event-Handler an den Discord-Client. */
  attach() {
    const client = this.ctx.client;
    const eventNames = new Set<keyof ClientEvents>();
    for (const m of this.modules) for (const e of Object.keys(m.events ?? {})) eventNames.add(e as keyof ClientEvents);

    for (const name of eventNames) {
      if (name === Events.InteractionCreate) continue; // eigene Behandlung unten
      client.on(name, (...args: unknown[]) => {
        void this.dispatch(name, args);
      });
    }
    client.on(Events.InteractionCreate, (i) => void this.onInteraction(i));
  }

  private async dispatch(name: keyof ClientEvents, args: unknown[]) {
    const guildId = extractGuildId(args);
    await Promise.all(
      this.modules.map(async (m) => {
        const handler = m.events?.[name] as ((ctx: BotContext, ...a: unknown[]) => unknown) | undefined;
        if (!handler) return;
        if (guildId && m.id !== 'core' && isModuleKey(m.id) && !(await this.ctx.config.isEnabled(guildId, m.id))) return;
        await this.run(m.id, `${String(name)}`, () => handler(this.ctx, ...args));
      }),
    );
  }

  emitInternal<K extends keyof InternalEvents>(name: K, payload: InternalEvents[K]) {
    for (const m of this.modules) {
      const handler = m.internal?.[name];
      if (!handler) continue;
      void (async () => {
        if (isModuleKey(m.id) && !(await this.ctx.config.isEnabled(payload.guildId, m.id))) return;
        await this.run(m.id, `internal:${name}`, () => handler(this.ctx, payload));
      })();
    }
  }

  /** Führt Code eines Moduls isoliert aus und protokolliert Fehler. */
  private async run(moduleId: ModuleId, label: string, fn: () => unknown) {
    try {
      await fn();
    } catch (err: any) {
      log.error({ err, module: moduleId, label }, 'Fehler in Modul');
      const r = redis();
      await r.hincrby(MODULE_ERRORS_KEY, moduleId, 1).catch(() => undefined);
      await r
        .hset(MODULE_LASTERROR_KEY, moduleId, JSON.stringify({ message: String(err?.message ?? err).slice(0, 500), label, at: Date.now() }))
        .catch(() => undefined);
    }
  }

  private async onInteraction(interaction: Interaction) {
    if (!interaction.inCachedGuild()) {
      if (interaction.isRepliable()) await interaction.reply({ content: 'Discord OS funktioniert nur auf Servern.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return;
    }

    if (interaction.isChatInputCommand() || interaction.isAutocomplete()) {
      const entry = this.commands.get(interaction.commandName);
      if (!entry) return;
      const enabled = !isModuleKey(entry.module) || (await this.ctx.config.isEnabled(interaction.guildId, entry.module));
      if (interaction.isAutocomplete()) {
        if (enabled && entry.command.autocomplete) await this.run(entry.module, `autocomplete:${interaction.commandName}`, () => entry.command.autocomplete!(interaction, this.ctx));
        else await interaction.respond([]).catch(() => undefined);
        return;
      }
      if (!enabled) {
        const name = isModuleKey(entry.module) ? MODULES[entry.module].name : entry.module;
        await interaction.reply({ embeds: [failure(`Das Modul **${name}** ist auf diesem Server deaktiviert.`)], flags: MessageFlags.Ephemeral });
        return;
      }
      await this.runInteraction(entry.module, `command:${interaction.commandName}`, interaction, () => entry.command.execute(interaction, this.ctx));
      return;
    }

    if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
      const [prefix, ...rest] = interaction.customId.split(':');
      const entry = this.components.get(prefix!);
      if (!entry) return;
      if (isModuleKey(entry.module) && !(await this.ctx.config.isEnabled(interaction.guildId, entry.module))) {
        await interaction.reply({ embeds: [failure('Diese Funktion ist auf diesem Server deaktiviert.')], flags: MessageFlags.Ephemeral });
        return;
      }
      await this.runInteraction(entry.module, `component:${prefix}`, interaction, () => entry.handler.handle(interaction, rest, this.ctx));
    }
  }

  /** Wie run(), antwortet dem Nutzer aber zusätzlich mit einer verständlichen Fehlermeldung. */
  private async runInteraction(moduleId: ModuleId, label: string, interaction: Interaction, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err: any) {
      const userMessage = err instanceof RpcError ? err.message : 'Es ist ein unerwarteter Fehler aufgetreten. Das Team wurde informiert.';
      if (!(err instanceof RpcError)) await this.run(moduleId, label, () => Promise.reject(err));
      if (interaction.isRepliable()) {
        const payload = { embeds: [failure(userMessage)], flags: MessageFlags.Ephemeral as const };
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => undefined);
        else await interaction.reply(payload).catch(() => undefined);
      }
    }
  }

  /** RPC-Aufrufe aus dem Dashboard an das zuständige Modul weiterleiten. */
  async handleRpc(method: string, params: any): Promise<unknown> {
    const entry = this.rpc.get(method);
    if (!entry) throw new RpcError('UNKNOWN_METHOD', `Unbekannte Methode: ${method}`);
    try {
      return await entry.fn(params ?? {}, this.ctx);
    } catch (err) {
      if (!(err instanceof RpcError)) await this.run(entry.module, `rpc:${method}`, () => Promise.reject(err));
      throw err;
    }
  }

  async ready() {
    for (const m of this.modules) {
      if (m.onReady) await this.run(m.id, 'onReady', () => m.onReady!(this.ctx));
      for (const job of m.jobs ?? []) this.schedule(m.id, job);
    }
    await this.registerCommands();
  }

  private schedule(moduleId: ModuleId, job: NonNullable<BotModule['jobs']>[number]) {
    let running = false;
    const tick = async () => {
      if (running) return; // keine überlappenden Läufe
      running = true;
      await this.run(moduleId, `job:${job.name}`, () => job.run(this.ctx));
      running = false;
    };
    const start = setTimeout(() => {
      void tick();
      this.timers.push(setInterval(() => void tick(), job.intervalMs));
    }, job.initialDelayMs ?? 5_000);
    this.timers.push(start);
  }

  private async registerCommands() {
    const e = env();
    const body = [...this.commands.values()].map((c) => c.command.data);
    const rest = new REST({ version: '10' }).setToken(e.DISCORD_TOKEN);
    try {
      if (e.DEV_GUILD_ID) {
        await rest.put(Routes.applicationGuildCommands(e.DISCORD_CLIENT_ID, e.DEV_GUILD_ID), { body });
        log.info({ count: body.length, guild: e.DEV_GUILD_ID }, 'Slash-Commands (Server) registriert');
      } else {
        await rest.put(Routes.applicationCommands(e.DISCORD_CLIENT_ID), { body });
        log.info({ count: body.length }, 'Slash-Commands (global) registriert');
      }
    } catch (err) {
      log.error({ err }, 'Slash-Commands konnten nicht registriert werden');
    }
  }

  listCommands() {
    return [...this.commands.values()].map((c) => ({ name: c.command.data.name, description: c.command.data.description, module: c.module }));
  }

  stop() {
    for (const t of this.timers) clearTimeout(t as NodeJS.Timeout);
    this.timers = [];
  }
}

/** Ermittelt die Server-ID aus beliebigen Event-Argumenten. */
function extractGuildId(args: unknown[]): string | null {
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i] as any;
    if (!a || typeof a !== 'object') continue;
    if (a instanceof Guild) return a.id;
    if (typeof a.guildId === 'string') return a.guildId;
    if (a.guild && typeof a.guild.id === 'string') return a.guild.id;
    if (a.message?.guildId) return a.message.guildId; // MessageReaction
  }
  return null;
}
