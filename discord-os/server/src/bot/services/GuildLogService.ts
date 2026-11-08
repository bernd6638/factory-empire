import { Prisma } from '@prisma/client';
import type { Client } from 'discord.js';
import { prisma } from '../../shared/prisma';
import { childLogger } from '../../shared/logger';
import type { LogCategory, ModuleConfig } from '../../shared/modules';
import type { ConfigService } from '../core/ConfigService';
import { embed, COLORS, truncate } from '../utils/embeds';
import { getSendableChannel } from '../utils/discord';

const log = childLogger('guild-log');

export type LogEventToggle = keyof ModuleConfig<'logging'>['events'];

export interface LogInput {
  guildId: string;
  category: LogCategory;
  type: string;
  /** Welcher Schalter in den Logging-Einstellungen dieses Ereignis steuert */
  toggle?: LogEventToggle;
  summary: string;
  actorId?: string | null;
  targetId?: string | null;
  channelId?: string | null;
  data?: Record<string, unknown>;
  color?: number;
  /** Zusätzliche Felder für die Discord-Embed-Ausgabe */
  fields?: { name: string; value: string; inline?: boolean }[];
}

/**
 * Schreibt Server-Ereignisse in die Datenbank (für das Dashboard), sendet sie live an das Dashboard
 * und optional als Embed in den konfigurierten Log-Kanal.
 */
export class GuildLogService {
  constructor(
    private client: Client,
    private config: ConfigService,
    private live: (guildId: string, type: string, data: unknown) => void,
  ) {}

  async write(input: LogInput): Promise<void> {
    try {
      const cfg = await this.config.ifEnabled(input.guildId, 'logging');
      if (!cfg) return;
      if (input.toggle && !cfg.events[input.toggle]) return;
      if (input.channelId && cfg.ignoredChannelIds.includes(input.channelId)) return;

      const entry = await prisma.logEntry.create({
        data: {
          guildId: input.guildId,
          category: input.category,
          type: input.type,
          summary: truncate(input.summary, 1000),
          actorId: input.actorId ?? null,
          targetId: input.targetId ?? null,
          channelId: input.channelId ?? null,
          data: (input.data ?? {}) as Prisma.InputJsonValue,
        },
      });

      this.live(input.guildId, 'log', {
        id: entry.id.toString(),
        category: entry.category,
        type: entry.type,
        summary: entry.summary,
        actorId: entry.actorId,
        targetId: entry.targetId,
        channelId: entry.channelId,
        data: entry.data,
        createdAt: entry.createdAt.toISOString(),
      });

      const channelId = cfg.channels[input.category];
      if (channelId) await this.postEmbed(input, channelId);
    } catch (err) {
      log.error({ err, type: input.type }, 'Log-Eintrag fehlgeschlagen');
    }
  }

  private async postEmbed(input: LogInput, channelId: string) {
    const guild = this.client.guilds.cache.get(input.guildId);
    if (!guild) return;
    const channel = await getSendableChannel(guild, channelId);
    if (!channel) return;
    const e = embed(input.color ?? COLORS.muted)
      .setTitle(titleFor(input.type))
      .setDescription(truncate(input.summary, 4000));
    if (input.fields?.length) e.addFields(input.fields.slice(0, 20).map((f) => ({ ...f, value: truncate(f.value || '—', 1024) })));
    const footer = [input.targetId && `Ziel: ${input.targetId}`, input.actorId && `Von: ${input.actorId}`].filter(Boolean).join(' • ');
    if (footer) e.setFooter({ text: footer });
    await channel.send({ embeds: [e], allowedMentions: { parse: [] } }).catch((err) => log.debug({ err: err.message }, 'Log-Embed konnte nicht gesendet werden'));
  }
}

const TITLES: Record<string, string> = {
  message_delete: '🗑️ Nachricht gelöscht',
  message_bulk_delete: '🗑️ Nachrichten gelöscht',
  message_update: '✏️ Nachricht bearbeitet',
  member_join: '📥 Mitglied beigetreten',
  member_leave: '📤 Mitglied hat verlassen',
  member_roles: '🎭 Rollen geändert',
  member_nickname: '🏷️ Nickname geändert',
  role_create: '➕ Rolle erstellt',
  role_delete: '➖ Rolle gelöscht',
  role_update: '🛠️ Rolle geändert',
  channel_create: '➕ Kanal erstellt',
  channel_delete: '➖ Kanal gelöscht',
  channel_update: '🛠️ Kanal geändert',
  voice_join: '🔊 Voice beigetreten',
  voice_leave: '🔇 Voice verlassen',
  voice_move: '🔀 Voice gewechselt',
  mod_action: '🔨 Moderation',
  automod: '🛡️ Auto-Moderation',
  raid: '🚨 Raid-Erkennung',
  ticket: '🎫 Ticket',
  server_update: '⚙️ Server geändert',
};

function titleFor(type: string): string {
  return TITLES[type] ?? type;
}
