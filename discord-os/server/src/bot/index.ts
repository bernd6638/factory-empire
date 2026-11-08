import { Client, Events, GatewayIntentBits, Options, Partials } from 'discord.js';
import { env } from '../shared/env';
import { Bus, BOT_STATUS_KEY } from '../shared/bus';
import { redis } from '../shared/redis';
import { childLogger } from '../shared/logger';
import { ConfigService } from './core/ConfigService';
import { StatsService } from './core/StatsService';
import { ModuleManager } from './core/ModuleManager';
import { GuildLogService } from './services/GuildLogService';
import { ModerationService } from './services/ModerationService';
import type { BotContext } from './core/types';
import { coreModule } from './modules/core';
import { moderationModule } from './modules/moderation';
import { automodModule } from './modules/automod';
import { levelingModule } from './modules/leveling';
import { ticketsModule } from './modules/tickets';
import { economyModule } from './modules/economy';
import { automationModule, invalidateAutomationCache } from './modules/automation';
import { welcomeModule } from './modules/welcome';
import { voiceModule } from './modules/voice';
import { loggingModule } from './modules/logging';

const log = childLogger('bot');

/**
 * Startet den Discord-Bot inklusive aller Module.
 * Gibt eine Funktion zum sauberen Herunterfahren zurück.
 */
export async function startBot(): Promise<() => Promise<void>> {
  const e = env();

  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privilegiert – im Developer-Portal aktivieren
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privilegiert – für Auto-Moderation, Logging, Automatisierungen
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
  ];
  if (e.ENABLE_PRESENCE_INTENT) intents.push(GatewayIntentBits.GuildPresences);

  const client = new Client({
    intents,
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember, Partials.User],
    allowedMentions: { parse: ['users'], repliedUser: false },
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 200,
      PresenceManager: e.ENABLE_PRESENCE_INTENT ? Infinity : 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 3600, lifetime: 6 * 3600 },
    },
  });

  const bus = new Bus('bot');
  const config = new ConfigService();
  const live = (guildId: string | null, type: string, data: unknown) => {
    bus.publishEvent(guildId, type, data).catch((err) => log.debug({ err: err.message }, 'Live-Event fehlgeschlagen'));
  };
  const stats = new StatsService((guildId, delta) => live(guildId, 'stats.tick', delta));
  const logs = new GuildLogService(client, config, live);
  const mod = new ModerationService(client, config, stats, logs, live);

  // ctx.client ist erst nach dem Login vollständig – Typ wird für Module als "ready" behandelt
  const ctx: BotContext = {
    client: client as Client<true>,
    bus,
    config,
    stats,
    logs,
    mod,
    live,
    emitInternal: (name, payload) => manager.emitInternal(name, payload),
  };

  const manager = new ModuleManager(ctx);
  manager.register(coreModule, moderationModule, automodModule, loggingModule, levelingModule, welcomeModule, ticketsModule, economyModule, automationModule, voiceModule);
  manager.register({
    id: 'core',
    rpc: {
      async 'bot.commands'() {
        return manager.listCommands();
      },
      async 'bot.ping'() {
        return { pong: Date.now(), ws: client.ws.ping };
      },
    },
  });
  manager.attach();

  await bus.onConfigChange(({ guildId, module }) => {
    config.invalidate(guildId, module);
    if (module === 'automation' || module === '*') invalidateAutomationCache(guildId);
  });
  await bus.serveRpc((method, params) => manager.handleRpc(method, params));

  client.once(Events.ClientReady, async (c) => {
    log.info({ tag: c.user.tag, guilds: c.guilds.cache.size }, 'Bot ist online');
    await manager.ready();
  });
  client.on(Events.ShardDisconnect, () => log.warn('Gateway-Verbindung getrennt'));
  client.on(Events.ShardReconnecting, () => log.info('Gateway verbindet neu …'));
  client.on(Events.Warn, (m) => log.warn(m));
  client.on(Events.Error, (err) => log.error({ err }, 'Discord-Client-Fehler'));

  stats.start();
  await loginWithRetry(client, e.DISCORD_TOKEN);

  return async () => {
    log.info('Bot wird heruntergefahren …');
    manager.stop();
    await stats.stop();
    await redis().del(BOT_STATUS_KEY).catch(() => undefined);
    await bus.publishEvent(null, 'bot.status', { online: false, updatedAt: Date.now() }).catch(() => undefined);
    await client.destroy();
    await bus.close();
  };
}

/** Meldet den Bot an. Netzwerkfehler werden mit wachsender Wartezeit wiederholt, ein ungültiger Token bricht ab. */
async function loginWithRetry(client: Client, token: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.login(token);
      return;
    } catch (err: any) {
      const code = String(err?.code ?? '');
      if (code === 'TokenInvalid' || code === 'DisallowedIntents' || /token/i.test(String(err?.message))) {
        log.fatal(
          code === 'DisallowedIntents'
            ? 'Privilegierte Intents sind nicht aktiviert. Aktiviere im Developer-Portal unter "Bot" die Intents "Server Members" und "Message Content".'
            : 'Der Discord-Token ist ungültig. Bitte DISCORD_TOKEN in der .env prüfen.',
        );
        throw err;
      }
      const delay = Math.min(5_000 * attempt, 60_000);
      log.warn({ err: err?.message, attempt }, `Anmeldung bei Discord fehlgeschlagen – neuer Versuch in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
