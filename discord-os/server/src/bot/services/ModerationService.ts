import { Prisma, type CaseSource, type CaseType, type ModCase } from '@prisma/client';
import { PermissionFlagsBits, type Client, type GuildMember } from 'discord.js';
import { prisma } from '../../shared/prisma';
import { RpcError } from '../../shared/bus';
import { formatDuration } from '../../shared/duration';
import { childLogger } from '../../shared/logger';
import type { ConfigService } from '../core/ConfigService';
import type { StatsService } from '../core/StatsService';
import type { GuildLogService } from './GuildLogService';
import { COLORS, embed, truncate } from '../utils/embeds';
import { actorCanModerate, botCanModerate, getSendableChannel, requireBotPermission } from '../utils/discord';

const log = childLogger('moderation');

export interface ModActionInput {
  guildId: string;
  type: CaseType;
  userId: string;
  moderatorId: string;
  reason?: string | null;
  /** Timeout-Dauer bzw. Dauer eines temporären Banns */
  durationMs?: number | null;
  source: CaseSource;
  /** Löscht beim Bann Nachrichten der letzten X Sekunden (max. 7 Tage) */
  deleteMessageSeconds?: number;
  /** Ausführendes Mitglied (für Hierarchieprüfung bei Commands) */
  actor?: GuildMember | null;
  skipEscalation?: boolean;
}

const MAX_TIMEOUT_MS = 28 * 24 * 3_600_000;

const LABELS: Record<CaseType, string> = {
  WARN: 'Verwarnung',
  TIMEOUT: 'Timeout',
  UNTIMEOUT: 'Timeout aufgehoben',
  KICK: 'Kick',
  BAN: 'Bann',
  UNBAN: 'Entbannung',
  NOTE: 'Notiz',
};

const CASE_COLORS: Record<CaseType, number> = {
  WARN: COLORS.warning,
  TIMEOUT: COLORS.warning,
  UNTIMEOUT: COLORS.success,
  KICK: COLORS.danger,
  BAN: COLORS.danger,
  UNBAN: COLORS.success,
  NOTE: COLORS.info,
};

export class ModerationService {
  constructor(
    private client: Client,
    private config: ConfigService,
    private stats: StatsService,
    private logs: GuildLogService,
    private live: (guildId: string, type: string, data: unknown) => void,
  ) {}

  caseLabel(type: CaseType) {
    return LABELS[type];
  }

  /** Führt eine Moderationsaktion aus, legt eine Fallakte an und protokolliert sie. */
  async perform(input: ModActionInput): Promise<ModCase> {
    const guild = this.client.guilds.cache.get(input.guildId);
    if (!guild) throw new RpcError('NOT_FOUND', 'Server nicht gefunden.');
    const { config: cfg } = await this.config.get(input.guildId, 'moderation');
    const reason = input.reason?.trim() || null;

    if (cfg.requireReason && !reason && (input.source === 'COMMAND' || input.source === 'DASHBOARD')) {
      throw new RpcError('VALIDATION', 'Für diese Aktion ist eine Begründung erforderlich.');
    }

    const member = await guild.members.fetch(input.userId).catch(() => null);
    const user = member?.user ?? (await this.client.users.fetch(input.userId).catch(() => null));
    if (!user) throw new RpcError('NOT_FOUND', 'Benutzer nicht gefunden.');
    if (user.id === this.client.user?.id) throw new RpcError('VALIDATION', 'Der Bot kann sich nicht selbst moderieren.');

    const needsMember = ['TIMEOUT', 'UNTIMEOUT', 'KICK'].includes(input.type);
    if (needsMember && !member) throw new RpcError('NOT_FOUND', 'Das Mitglied ist nicht (mehr) auf dem Server.');

    // Berechtigungen & Hierarchie
    const permMap: Partial<Record<CaseType, [bigint, string]>> = {
      TIMEOUT: [PermissionFlagsBits.ModerateMembers, 'Mitglieder im Timeout'],
      UNTIMEOUT: [PermissionFlagsBits.ModerateMembers, 'Mitglieder im Timeout'],
      KICK: [PermissionFlagsBits.KickMembers, 'Mitglieder kicken'],
      BAN: [PermissionFlagsBits.BanMembers, 'Mitglieder bannen'],
      UNBAN: [PermissionFlagsBits.BanMembers, 'Mitglieder bannen'],
    };
    const needed = permMap[input.type];
    if (needed) requireBotPermission(guild, needed[0], needed[1]);

    if (member && ['TIMEOUT', 'KICK', 'BAN', 'WARN'].includes(input.type)) {
      if (input.type !== 'WARN' && !botCanModerate(member)) {
        throw new RpcError('HIERARCHY', 'Die höchste Rolle des Bots muss über der des Mitglieds stehen.');
      }
      if (input.actor && !actorCanModerate(input.actor, member)) {
        throw new RpcError('HIERARCHY', 'Du kannst kein Mitglied mit gleicher oder höherer Rolle moderieren.');
      }
      if (input.source !== 'SYSTEM' && member.roles.cache.some((r) => cfg.protectedRoleIds.includes(r.id)) && input.moderatorId !== guild.ownerId) {
        throw new RpcError('PROTECTED', 'Dieses Mitglied besitzt eine geschützte Rolle.');
      }
    }

    let durationMs = input.durationMs ?? null;
    if (input.type === 'TIMEOUT') {
      if (!durationMs || durationMs <= 0) throw new RpcError('VALIDATION', 'Für einen Timeout wird eine Dauer benötigt.');
      durationMs = Math.min(durationMs, MAX_TIMEOUT_MS);
    }
    const expiresAt = durationMs && (input.type === 'TIMEOUT' || input.type === 'BAN') ? new Date(Date.now() + durationMs) : null;
    const auditReason = truncate(`${reason ?? 'Kein Grund angegeben'} (von ${input.moderatorId})`, 512);

    // DM vor Kick/Bann senden, danach ist es nicht mehr möglich
    if (cfg.dmOnAction && ['WARN', 'TIMEOUT', 'KICK', 'BAN'].includes(input.type) && !user.bot) {
      const dm = embed(CASE_COLORS[input.type])
        .setTitle(`${LABELS[input.type]} auf ${guild.name}`)
        .addFields({ name: 'Grund', value: truncate(reason ?? 'Kein Grund angegeben', 1024) });
      if (durationMs) dm.addFields({ name: 'Dauer', value: formatDuration(durationMs), inline: true });
      await user.send({ embeds: [dm] }).catch(() => undefined);
    }

    // Aktion in Discord ausführen
    try {
      switch (input.type) {
        case 'TIMEOUT':
          await member!.timeout(durationMs!, auditReason);
          break;
        case 'UNTIMEOUT':
          await member!.timeout(null, auditReason);
          break;
        case 'KICK':
          await member!.kick(auditReason);
          break;
        case 'BAN':
          await guild.bans.create(user.id, { reason: auditReason, deleteMessageSeconds: Math.min(input.deleteMessageSeconds ?? 0, 604800) });
          break;
        case 'UNBAN': {
          const ban = await guild.bans.fetch(user.id).catch(() => null);
          if (!ban) throw new RpcError('NOT_FOUND', 'Dieser Benutzer ist nicht gebannt.');
          await guild.bans.remove(user.id, auditReason);
          break;
        }
        default:
          break;
      }
    } catch (err: any) {
      if (err instanceof RpcError) throw err;
      log.warn({ err: err?.message, type: input.type }, 'Discord-Aktion fehlgeschlagen');
      throw new RpcError('DISCORD_ERROR', `Discord hat die Aktion abgelehnt: ${err?.message ?? 'Unbekannter Fehler'}`);
    }

    // Vorherige Fälle deaktivieren
    if (input.type === 'UNBAN') {
      await prisma.modCase.updateMany({ where: { guildId: guild.id, userId: user.id, type: 'BAN', active: true }, data: { active: false } });
    } else if (input.type === 'UNTIMEOUT') {
      await prisma.modCase.updateMany({ where: { guildId: guild.id, userId: user.id, type: 'TIMEOUT', active: true }, data: { active: false } });
    }

    const modCase = await this.createCase({
      guildId: guild.id,
      type: input.type,
      userId: user.id,
      userTag: user.username,
      moderatorId: input.moderatorId,
      reason,
      durationSec: durationMs ? Math.round(durationMs / 1000) : null,
      expiresAt,
      // Kicks und Notizen sind abgeschlossene Vorgänge
      active: !['KICK', 'NOTE', 'UNBAN', 'UNTIMEOUT'].includes(input.type),
      source: input.source,
    });

    this.stats.modAction(guild.id);
    const payload = serializeCase(modCase);
    this.live(guild.id, 'mod.case', payload);

    const fields = [
      { name: 'Mitglied', value: `<@${user.id}> (${user.username})`, inline: true },
      { name: 'Moderator', value: input.moderatorId === this.client.user?.id ? 'Discord OS' : `<@${input.moderatorId}>`, inline: true },
      { name: 'Grund', value: reason ?? 'Kein Grund angegeben' },
    ];
    if (durationMs) fields.push({ name: 'Dauer', value: formatDuration(durationMs), inline: true });

    await this.logs.write({
      guildId: guild.id,
      category: 'moderation',
      type: 'mod_action',
      toggle: 'moderation',
      summary: `Fall #${modCase.caseNumber}: ${LABELS[input.type]} für ${user.username}${reason ? ` – ${reason}` : ''}`,
      actorId: input.moderatorId,
      targetId: user.id,
      data: { caseNumber: modCase.caseNumber, caseType: input.type, source: input.source, durationSec: modCase.durationSec },
      color: CASE_COLORS[input.type],
      fields,
    });

    if (cfg.logChannelId) {
      const ch = await getSendableChannel(guild, cfg.logChannelId);
      await ch
        ?.send({ embeds: [embed(CASE_COLORS[input.type]).setTitle(`Fall #${modCase.caseNumber} • ${LABELS[input.type]}`).addFields(fields)], allowedMentions: { parse: [] } })
        .catch(() => undefined);
    }

    if (input.type === 'WARN' && !input.skipEscalation) {
      await this.escalate(guild.id, user.id).catch((err) => log.warn({ err: err?.message }, 'Eskalation fehlgeschlagen'));
    }
    return modCase;
  }

  /** Vergibt eine fortlaufende Fallnummer pro Server (mit Wiederholung bei gleichzeitigen Aktionen). */
  private async createCase(data: Omit<Prisma.ModCaseUncheckedCreateInput, 'caseNumber'>): Promise<ModCase> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await prisma.modCase.findFirst({ where: { guildId: data.guildId }, orderBy: { caseNumber: 'desc' }, select: { caseNumber: true } });
      try {
        return await prisma.modCase.create({ data: { ...data, caseNumber: (last?.caseNumber ?? 0) + 1 } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
    }
    throw new Error('Fallnummer konnte nicht vergeben werden');
  }

  async activeWarningCount(guildId: string, userId: string): Promise<number> {
    const { config: cfg } = await this.config.get(guildId, 'moderation');
    const since = cfg.warnExpiryDays > 0 ? new Date(Date.now() - cfg.warnExpiryDays * 86_400_000) : undefined;
    return prisma.modCase.count({ where: { guildId, userId, type: 'WARN', active: true, ...(since ? { createdAt: { gte: since } } : {}) } });
  }

  /** Automatische Eskalation: bei Erreichen einer Verwarnungsschwelle wird die konfigurierte Aktion ausgeführt. */
  private async escalate(guildId: string, userId: string) {
    const { config: cfg } = await this.config.get(guildId, 'moderation');
    if (cfg.escalation.length === 0) return;
    const count = await this.activeWarningCount(guildId, userId);
    const rule = cfg.escalation.find((r) => r.warnings === count);
    if (!rule) return;
    const type: CaseType = rule.action === 'timeout' ? 'TIMEOUT' : rule.action === 'kick' ? 'KICK' : 'BAN';
    await this.perform({
      guildId,
      type,
      userId,
      moderatorId: this.client.user!.id,
      reason: `Automatische Eskalation: ${count} Verwarnungen`,
      durationMs: type === 'TIMEOUT' ? rule.durationMinutes * 60_000 : null,
      source: 'SYSTEM',
      skipEscalation: true,
    });
  }

  /** Deaktiviert eine Verwarnung (z. B. aus dem Dashboard). */
  async revokeCase(guildId: string, caseNumber: number, byUserId: string) {
    const c = await prisma.modCase.findUnique({ where: { guildId_caseNumber: { guildId, caseNumber } } });
    if (!c) throw new RpcError('NOT_FOUND', 'Fall nicht gefunden.');
    const updated = await prisma.modCase.update({ where: { id: c.id }, data: { active: false } });
    this.live(guildId, 'mod.case', serializeCase(updated));
    await this.logs.write({
      guildId,
      category: 'moderation',
      type: 'mod_action',
      toggle: 'moderation',
      summary: `Fall #${caseNumber} (${LABELS[c.type]}) wurde aufgehoben`,
      actorId: byUserId,
      targetId: c.userId,
      data: { caseNumber, revoked: true },
      color: COLORS.success,
    });
    return updated;
  }

  /** Abgelaufene temporäre Banns aufheben und Timeouts als beendet markieren. */
  async processExpired() {
    const now = new Date();
    const expired = await prisma.modCase.findMany({
      where: { active: true, expiresAt: { lte: now }, type: { in: ['BAN', 'TIMEOUT'] } },
      take: 100,
    });
    for (const c of expired) {
      if (c.type === 'TIMEOUT') {
        await prisma.modCase.update({ where: { id: c.id }, data: { active: false } });
        continue;
      }
      const guild = this.client.guilds.cache.get(c.guildId);
      if (!guild) continue;
      try {
        await this.perform({
          guildId: c.guildId,
          type: 'UNBAN',
          userId: c.userId,
          moderatorId: this.client.user!.id,
          reason: `Temporärer Bann (Fall #${c.caseNumber}) abgelaufen`,
          source: 'SYSTEM',
        });
      } catch (err: any) {
        // Bereits entbannt o. ä. → Fall trotzdem schließen
        await prisma.modCase.update({ where: { id: c.id }, data: { active: false } });
        log.debug({ err: err?.message }, 'Temp-Bann konnte nicht aufgehoben werden');
      }
    }
  }
}

export function serializeCase(c: ModCase) {
  return {
    ...c,
    createdAt: c.createdAt.toISOString(),
    expiresAt: c.expiresAt?.toISOString() ?? null,
  };
}
