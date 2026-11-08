import { prisma } from '../../shared/prisma';
import { dayStart, hourStart } from '../../shared/duration';
import { childLogger } from '../../shared/logger';

const log = childLogger('stats');

interface GuildCounter {
  messages: number;
  joins: number;
  leaves: number;
  modActions: number;
  voiceMinutes: number;
}

interface MemberCounter {
  guildId: string;
  userId: string;
  username: string;
  avatar: string | null;
  bot: boolean;
  messages: number;
  xp: number;
  voiceMinutes: number;
  lastMessageAt: Date | null;
}

/**
 * Sammelt Zähler im Speicher und schreibt sie gebündelt (alle 15 s) per Bulk-Upsert in die Datenbank.
 * So verursacht nicht jede Nachricht einen eigenen Datenbankzugriff.
 */
export class StatsService {
  private guilds = new Map<string, GuildCounter>();
  private members = new Map<string, MemberCounter>();
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(private onFlush?: (guildId: string, delta: GuildCounter) => void) {}

  start(intervalMs = 15_000) {
    this.timer = setInterval(() => void this.flush(), intervalMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  private guild(guildId: string): GuildCounter {
    let g = this.guilds.get(guildId);
    if (!g) {
      g = { messages: 0, joins: 0, leaves: 0, modActions: 0, voiceMinutes: 0 };
      this.guilds.set(guildId, g);
    }
    return g;
  }

  private member(guildId: string, user: { id: string; username: string; avatar: string | null; bot: boolean }): MemberCounter {
    const k = `${guildId}:${user.id}`;
    let m = this.members.get(k);
    if (!m) {
      m = { guildId, userId: user.id, username: user.username, avatar: user.avatar, bot: user.bot, messages: 0, xp: 0, voiceMinutes: 0, lastMessageAt: null };
      this.members.set(k, m);
    }
    return m;
  }

  message(guildId: string, user: { id: string; username: string; avatar: string | null; bot: boolean }) {
    this.guild(guildId).messages++;
    const m = this.member(guildId, user);
    m.messages++;
    m.lastMessageAt = new Date();
  }

  xp(guildId: string, user: { id: string; username: string; avatar: string | null; bot: boolean }, amount: number) {
    this.member(guildId, user).xp += amount;
  }

  voice(guildId: string, user: { id: string; username: string; avatar: string | null; bot: boolean }, minutes: number) {
    this.guild(guildId).voiceMinutes += minutes;
    this.member(guildId, user).voiceMinutes += minutes;
  }

  join(guildId: string) {
    this.guild(guildId).joins++;
  }

  leave(guildId: string) {
    this.guild(guildId).leaves++;
  }

  modAction(guildId: string) {
    this.guild(guildId).modActions++;
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    const guilds = this.guilds;
    const members = this.members;
    this.guilds = new Map();
    this.members = new Map();
    try {
      const hour = hourStart();
      const day = dayStart();
      if (guilds.size > 0) {
        const ids = [...guilds.keys()];
        const rows = ids.map((id) => guilds.get(id)!);
        await prisma.$executeRaw`
          INSERT INTO "GuildStatHour" ("guildId", "hour", "messages", "joins", "leaves", "modActions", "voiceMinutes")
          SELECT g, ${hour}::timestamp, m, j, l, a, v
          FROM UNNEST(${ids}::text[], ${rows.map((r) => r.messages)}::int[], ${rows.map((r) => r.joins)}::int[],
                      ${rows.map((r) => r.leaves)}::int[], ${rows.map((r) => r.modActions)}::int[], ${rows.map((r) => r.voiceMinutes)}::int[])
               AS t(g, m, j, l, a, v)
          WHERE EXISTS (SELECT 1 FROM "Guild" WHERE "Guild"."id" = t.g)
          ON CONFLICT ("guildId", "hour") DO UPDATE SET
            "messages" = "GuildStatHour"."messages" + EXCLUDED."messages",
            "joins" = "GuildStatHour"."joins" + EXCLUDED."joins",
            "leaves" = "GuildStatHour"."leaves" + EXCLUDED."leaves",
            "modActions" = "GuildStatHour"."modActions" + EXCLUDED."modActions",
            "voiceMinutes" = "GuildStatHour"."voiceMinutes" + EXCLUDED."voiceMinutes"`;
        for (const [id, delta] of guilds) this.onFlush?.(id, delta);
      }
      if (members.size > 0) {
        const list = [...members.values()];
        const gid = list.map((m) => m.guildId);
        const uid = list.map((m) => m.userId);
        await prisma.$executeRaw`
          INSERT INTO "MemberDailyStat" ("guildId", "userId", "date", "messages", "xp", "voiceMinutes")
          SELECT g, u, ${day}::date, m, x, v
          FROM UNNEST(${gid}::text[], ${uid}::text[], ${list.map((m) => m.messages)}::int[], ${list.map((m) => m.xp)}::int[], ${list.map((m) => m.voiceMinutes)}::int[])
               AS t(g, u, m, x, v)
          WHERE EXISTS (SELECT 1 FROM "Guild" WHERE "Guild"."id" = t.g)
          ON CONFLICT ("guildId", "userId", "date") DO UPDATE SET
            "messages" = "MemberDailyStat"."messages" + EXCLUDED."messages",
            "xp" = "MemberDailyStat"."xp" + EXCLUDED."xp",
            "voiceMinutes" = "MemberDailyStat"."voiceMinutes" + EXCLUDED."voiceMinutes"`;
        await prisma.$executeRaw`
          INSERT INTO "MemberProfile" ("guildId", "userId", "username", "avatar", "bot", "messages", "voiceMinutes", "lastMessageAt", "inGuild", "createdAt", "updatedAt")
          SELECT g, u, n, a, b, m, v, lm, true, now(), now()
          FROM UNNEST(${gid}::text[], ${uid}::text[], ${list.map((m) => m.username)}::text[], ${list.map((m) => m.avatar)}::text[],
                      ${list.map((m) => m.bot)}::boolean[], ${list.map((m) => m.messages)}::int[], ${list.map((m) => m.voiceMinutes)}::int[],
                      ${list.map((m) => m.lastMessageAt)}::timestamp[])
               AS t(g, u, n, a, b, m, v, lm)
          WHERE EXISTS (SELECT 1 FROM "Guild" WHERE "Guild"."id" = t.g)
          ON CONFLICT ("guildId", "userId") DO UPDATE SET
            "username" = EXCLUDED."username",
            "avatar" = EXCLUDED."avatar",
            "messages" = "MemberProfile"."messages" + EXCLUDED."messages",
            "voiceMinutes" = "MemberProfile"."voiceMinutes" + EXCLUDED."voiceMinutes",
            "lastMessageAt" = COALESCE(EXCLUDED."lastMessageAt", "MemberProfile"."lastMessageAt"),
            "inGuild" = true,
            "updatedAt" = now()`;
      }
    } catch (err) {
      log.error({ err }, 'Statistik konnte nicht gespeichert werden');
    } finally {
      this.flushing = false;
    }
  }
}
