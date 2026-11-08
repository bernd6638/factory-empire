import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ClientEvents,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  StringSelectMenuInteraction,
} from 'discord.js';
import type { Bus } from '../../shared/bus';
import type { ModuleKey } from '../../shared/modules';
import type { ConfigService } from './ConfigService';
import type { StatsService } from './StatsService';
import type { GuildLogService } from '../services/GuildLogService';
import type { ModerationService } from '../services/ModerationService';

export interface BotContext {
  client: Client<true>;
  bus: Bus;
  config: ConfigService;
  stats: StatsService;
  logs: GuildLogService;
  mod: ModerationService;
  /** Sendet ein Live-Ereignis an das Dashboard. */
  live: (guildId: string | null, type: string, data: unknown) => void;
  /** Interne Ereignisse zwischen Modulen (z. B. Level-Up → Automatisierung). */
  emitInternal: <K extends keyof InternalEvents>(name: K, payload: InternalEvents[K]) => void;
}

export interface InternalEvents {
  levelUp: { guildId: string; userId: string; level: number; channelId: string | null };
}

export type ModuleId = ModuleKey | 'core';

export interface SlashCommand {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute: (interaction: ChatInputCommandInteraction<'cached'>, ctx: BotContext) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction<'cached'>, ctx: BotContext) => Promise<void>;
}

export type ComponentInteraction =
  | ButtonInteraction<'cached'>
  | StringSelectMenuInteraction<'cached'>
  | ModalSubmitInteraction<'cached'>;

export interface ComponentHandler {
  /** customId-Präfix, z. B. "tickets" → "tickets:open:support" */
  prefix: string;
  handle: (interaction: ComponentInteraction, args: string[], ctx: BotContext) => Promise<void>;
}

export type EventHandlers = {
  [K in keyof ClientEvents]?: (ctx: BotContext, ...args: ClientEvents[K]) => Promise<void> | void;
};

export type InternalHandlers = {
  [K in keyof InternalEvents]?: (ctx: BotContext, payload: InternalEvents[K]) => Promise<void> | void;
};

export interface Job {
  name: string;
  intervalMs: number;
  /** Erste Ausführung nach Start verzögern */
  initialDelayMs?: number;
  run: (ctx: BotContext) => Promise<void>;
}

export interface BotModule {
  id: ModuleId;
  commands?: SlashCommand[];
  components?: ComponentHandler[];
  events?: EventHandlers;
  internal?: InternalHandlers;
  jobs?: Job[];
  /** RPC-Methoden, die das Dashboard aufrufen kann */
  rpc?: Record<string, (params: any, ctx: BotContext) => Promise<unknown>>;
  onReady?: (ctx: BotContext) => Promise<void>;
}
