import {
  ChannelType,
  GuildDefaultMessageNotifications,
  GuildExplicitContentFilter,
  GuildVerificationLevel,
  OverwriteType,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
  type Guild,
  type GuildMember,
  type Role,
  MessageFlags,
} from 'discord.js';
import { z } from 'zod';
import { prisma } from '../../shared/prisma';
import { redis } from '../../shared/redis';
import { BOT_STATUS_KEY, RpcError, type BotStatus } from '../../shared/bus';
import { env } from '../../shared/env';
import { dayStart } from '../../shared/duration';
import { childLogger } from '../../shared/logger';
import type { BotContext, BotModule } from '../core/types';
import { avatarUrl, botCanManageRole, requireBotPermission, userSnapshot } from '../utils/discord';
import { embed, COLORS } from '../utils/embeds';
import { snowflake } from '../../shared/modules';

const log = childLogger('core');
const startedAt = Date.now();

export function getGuild(ctx: BotContext, guildId: unknown): Guild {
  if (typeof guildId !== 'string') throw new RpcError('VALIDATION', 'guildId fehlt');
  const g = ctx.client.guilds.cache.get(guildId);
  if (!g) throw new RpcError('NOT_FOUND', 'Der Bot ist nicht auf diesem Server.');
  return g;
}

export function parse<T extends z.ZodType>(schema: T, params: unknown): z.infer<T> {
  const res = schema.safeParse(params);
  if (!res.success) throw new RpcError('VALIDATION', res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', '));
  return res.data;
}

// ─── Serialisierung ───

export function serializeRole(role: Role) {
  return {
    id: role.id,
    name: role.name,
    color: role.hexColor,
    position: role.position,
    permissions: role.permissions.bitfield.toString(),
    hoist: role.hoist,
    mentionable: role.mentionable,
    managed: role.managed,
    everyone: role.id === role.guild.id,
    memberCount: role.members.size,
    editable: botCanManageRole(role.guild, role.id) || (role.id === role.guild.id && !!role.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)),
    icon: role.iconURL(),
  };
}

export function serializeMember(m: GuildMember) {
  return {
    id: m.id,
    username: m.user.username,
    displayName: m.displayName,
    avatar: m.displayAvatarURL({ size: 128 }),
    bot: m.user.bot,
    joinedAt: m.joinedAt?.toISOString() ?? null,
    createdAt: m.user.createdAt.toISOString(),
    roles: m.roles.cache.filter((r) => r.id !== m.guild.id).sort((a, b) => b.position - a.position).map((r) => r.id),
    highestRoleColor: m.displayHexColor,
    timedOutUntil: m.communicationDisabledUntil && m.communicationDisabledUntil > new Date() ? m.communicationDisabledUntil.toISOString() : null,
    status: m.presence?.status ?? null,
    pending: m.pending,
  };
}

async function syncGuild(guild: Guild) {
  await prisma.guild.upsert({
    where: { id: guild.id },
    create: { id: guild.id, name: guild.name, icon: guild.icon, ownerId: guild.ownerId, memberCount: guild.memberCount, active: true },
    update: { name: guild.name, icon: guild.icon, ownerId: guild.ownerId, memberCount: guild.memberCount, active: true, leftAt: null },
  });
}

async function upsertProfile(m: GuildMember, extra: { inGuild: boolean; leftAt?: Date | null }) {
  await prisma.memberProfile.upsert({
    where: { guildId_userId: { guildId: m.guild.id, userId: m.id } },
    create: {
      guildId: m.guild.id,
      userId: m.id,
      username: m.user.username,
      avatar: m.user.avatar,
      bot: m.user.bot,
      joinedAt: m.joinedAt ?? new Date(),
      inGuild: extra.inGuild,
      leftAt: extra.leftAt ?? null,
    },
    update: {
      username: m.user.username,
      avatar: m.user.avatar,
      inGuild: extra.inGuild,
      leftAt: extra.leftAt ?? null,
      ...(extra.inGuild ? { joinedAt: m.joinedAt ?? new Date() } : {}),
    },
  });
}

async function writeHeartbeat(ctx: BotContext) {
  const c = ctx.client;
  const status: BotStatus = {
    online: true,
    ping: Math.max(0, Math.round(c.ws.ping)),
    guilds: c.guilds.cache.size,
    users: c.guilds.cache.reduce((a, g) => a + g.memberCount, 0),
    uptimeMs: Date.now() - startedAt,
    startedAt,
    tag: c.user.tag,
    avatar: c.user.displayAvatarURL({ size: 128 }),
    id: c.user.id,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    updatedAt: Date.now(),
  };
  await redis().set(BOT_STATUS_KEY, JSON.stringify(status), 'EX', 45);
  ctx.live(null, 'bot.status', status);
}

/** Online-Zahl: Presence-Cache (falls Intent aktiv), sonst approximate_presence_count der API. */
async function onlineCount(ctx: BotContext, guild: Guild): Promise<number> {
  if (env().ENABLE_PRESENCE_INTENT) {
    return guild.presences.cache.filter((p) => p.status !== 'offline').size;
  }
  const fetched = await ctx.client.guilds.fetch({ guild: guild.id, withCounts: true, force: true }).catch(() => null);
  return fetched?.approximatePresenceCount ?? 0;
}

async function snapshot(ctx: BotContext, guild: Guild) {
  const online = await onlineCount(ctx, guild);
  await redis().set(`dos:online:${guild.id}`, String(online), 'EX', 3600);
  const date = dayStart();
  await prisma.$executeRaw`
    INSERT INTO "GuildStatDay" ("guildId", "date", "memberCount", "onlinePeak")
    VALUES (${guild.id}, ${date}::date, ${guild.memberCount}, ${online})
    ON CONFLICT ("guildId", "date") DO UPDATE SET
      "memberCount" = EXCLUDED."memberCount",
      "onlinePeak" = GREATEST("GuildStatDay"."onlinePeak", EXCLUDED."onlinePeak")`;
  await prisma.guild.update({ where: { id: guild.id }, data: { memberCount: guild.memberCount } }).catch(() => undefined);
  ctx.live(guild.id, 'stats.snapshot', { memberCount: guild.memberCount, online });
}

const roleInput = z.object({
  guildId: snowflake,
  name: z.string().min(1).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
  permissions: z.string().regex(/^\d+$/).optional(),
});

function assertPermissionsGrantable(guild: Guild, permissions: string | undefined) {
  if (!permissions) return;
  const me = guild.members.me!;
  const wanted = new PermissionsBitField(BigInt(permissions));
  // Der Bot kann keine Rechte vergeben, die er selbst nicht besitzt
  if (!me.permissions.has(PermissionFlagsBits.Administrator) && !me.permissions.has(wanted)) {
    const missing = wanted.toArray().filter((p) => !me.permissions.has(p));
    throw new RpcError('MISSING_PERMISSIONS', `Der Bot kann folgende Rechte nicht vergeben, da er sie selbst nicht besitzt: ${missing.join(', ')}`);
  }
}

export const coreModule: BotModule = {
  id: 'core',

  commands: [
    {
      data: new SlashCommandBuilder().setName('serverinfo').setDescription('Zeigt Informationen über diesen Server').toJSON(),
      async execute(i) {
        const g = i.guild;
        const e = embed(COLORS.brand)
          .setTitle(g.name)
          .setThumbnail(g.iconURL({ size: 256 }))
          .addFields(
            { name: 'Mitglieder', value: g.memberCount.toLocaleString('de-DE'), inline: true },
            { name: 'Kanäle', value: String(g.channels.cache.size), inline: true },
            { name: 'Rollen', value: String(g.roles.cache.size - 1), inline: true },
            { name: 'Boosts', value: `${g.premiumSubscriptionCount ?? 0} (Stufe ${g.premiumTier})`, inline: true },
            { name: 'Erstellt', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:D>`, inline: true },
            { name: 'Besitzer', value: `<@${g.ownerId}>`, inline: true },
          );
        await i.reply({ embeds: [e] });
      },
    },
    {
      data: new SlashCommandBuilder().setName('dashboard').setDescription('Link zum Discord-OS-Dashboard').toJSON(),
      async execute(i) {
        await i.reply({ content: `🖥️ Dashboard: ${env().PUBLIC_URL}/guild/${i.guildId}`, flags: MessageFlags.Ephemeral });
      },
    },
  ],

  async onReady(ctx) {
    const guilds = [...ctx.client.guilds.cache.values()];
    for (const g of guilds) await syncGuild(g);
    // Server, die der Bot während der Offline-Zeit verlassen hat, als inaktiv markieren
    await prisma.guild.updateMany({ where: { id: { notIn: guilds.map((g) => g.id) }, active: true }, data: { active: false, leftAt: new Date() } });
    await writeHeartbeat(ctx);
    log.info({ guilds: guilds.length }, 'Server synchronisiert');

    // Mitgliederlisten im Hintergrund laden (benötigt GuildMembers-Intent)
    void (async () => {
      for (const g of guilds) {
        if (g.memberCount > 50_000) continue;
        await g.members.fetch().catch((err) => log.warn({ err: err?.message, guild: g.id }, 'Mitglieder konnten nicht geladen werden'));
        await new Promise((r) => setTimeout(r, 1500));
      }
      log.info('Mitglieder-Cache geladen');
    })();
  },

  events: {
    async guildCreate(ctx, guild) {
      await syncGuild(guild);
      log.info({ guild: guild.id, name: guild.name }, 'Neuem Server beigetreten');
      ctx.live(null, 'guild.joined', { id: guild.id, name: guild.name });
      await guild.members.fetch().catch(() => undefined);
      await snapshot(ctx, guild).catch(() => undefined);
    },
    async guildDelete(ctx, guild) {
      await prisma.guild.updateMany({ where: { id: guild.id }, data: { active: false, leftAt: new Date() } });
      ctx.live(null, 'guild.left', { id: guild.id });
    },
    async guildUpdate(ctx, _old, guild) {
      await syncGuild(guild);
      ctx.live(guild.id, 'guild.updated', { name: guild.name, icon: guild.icon });
    },
    async messageCreate(ctx, message) {
      if (!message.inGuild() || message.author.bot || message.system) return;
      ctx.stats.message(message.guildId, userSnapshot(message.author));
    },
    async guildMemberAdd(ctx, member) {
      ctx.stats.join(member.guild.id);
      await upsertProfile(member, { inGuild: true });
      ctx.live(member.guild.id, 'member.join', { ...serializeMember(member), memberCount: member.guild.memberCount });
    },
    async guildMemberRemove(ctx, member) {
      ctx.stats.leave(member.guild.id);
      await prisma.memberProfile.updateMany({ where: { guildId: member.guild.id, userId: member.id }, data: { inGuild: false, leftAt: new Date() } });
      ctx.live(member.guild.id, 'member.leave', { id: member.id, username: member.user?.username ?? 'Unbekannt', memberCount: member.guild.memberCount });
    },
  },

  jobs: [
    { name: 'heartbeat', intervalMs: 15_000, initialDelayMs: 1_000, run: writeHeartbeat },
    {
      name: 'voice-minutes',
      intervalMs: 60_000,
      initialDelayMs: 60_000,
      async run(ctx) {
        for (const g of ctx.client.guilds.cache.values()) {
          for (const vs of g.voiceStates.cache.values()) {
            if (!vs.channelId || vs.channelId === g.afkChannelId || !vs.member || vs.member.user.bot) continue;
            ctx.stats.voice(g.id, userSnapshot(vs.member.user), 1);
          }
        }
      },
    },
    {
      name: 'snapshot',
      intervalMs: 10 * 60_000,
      initialDelayMs: 20_000,
      async run(ctx) {
        for (const g of ctx.client.guilds.cache.values()) {
          await snapshot(ctx, g).catch((err) => log.debug({ err: err?.message }, 'Snapshot fehlgeschlagen'));
          await new Promise((r) => setTimeout(r, 250));
        }
      },
    },
  ],

  rpc: {
    async 'guild.info'(p, ctx) {
      const g = getGuild(ctx, p.guildId);
      const me = g.members.me;
      const online = Number((await redis().get(`dos:online:${g.id}`)) ?? 0);
      return {
        id: g.id,
        name: g.name,
        icon: g.iconURL({ size: 256 }),
        banner: g.bannerURL({ size: 1024 }),
        description: g.description,
        ownerId: g.ownerId,
        memberCount: g.memberCount,
        online,
        createdAt: g.createdAt.toISOString(),
        boosts: g.premiumSubscriptionCount ?? 0,
        boostTier: g.premiumTier,
        verificationLevel: g.verificationLevel,
        explicitContentFilter: g.explicitContentFilter,
        defaultMessageNotifications: g.defaultMessageNotifications,
        systemChannelId: g.systemChannelId,
        afkChannelId: g.afkChannelId,
        afkTimeout: g.afkTimeout,
        preferredLocale: g.preferredLocale,
        channelCount: g.channels.cache.size,
        roleCount: g.roles.cache.size - 1,
        emojiCount: g.emojis.cache.size,
        cachedMembers: g.members.cache.size,
        botPermissions: me?.permissions.bitfield.toString() ?? '0',
        botMissing: me
          ? (['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ManageMessages', 'ViewAuditLog', 'MoveMembers'] as const).filter(
              (p) => !me.permissions.has(PermissionFlagsBits[p]),
            )
          : [],
        botHighestRole: me?.roles.highest.position ?? 0,
      };
    },

    async 'guild.channels'(p, ctx) {
      const g = getGuild(ctx, p.guildId);
      const me = g.members.me;
      return g.channels.cache
        .filter((c) => !c.isThread())
        .map((c) => {
          const anyC = c as any;
          return {
            id: c.id,
            name: c.name,
            type: c.type,
            parentId: c.parentId,
            position: anyC.rawPosition ?? anyC.position ?? 0,
            topic: anyC.topic ?? null,
            nsfw: anyC.nsfw ?? false,
            userLimit: anyC.userLimit ?? null,
            botCanSend: me ? !!c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) : false,
            overwrites: anyC.permissionOverwrites
              ? [...anyC.permissionOverwrites.cache.values()].map((o: any) => ({
                  id: o.id,
                  type: o.type === OverwriteType.Role ? 'role' : 'member',
                  allow: o.allow.bitfield.toString(),
                  deny: o.deny.bitfield.toString(),
                }))
              : [],
          };
        })
        .sort((a, b) => a.position - b.position);
    },

    async 'guild.roles'(p, ctx) {
      const g = getGuild(ctx, p.guildId);
      return g.roles.cache.sort((a, b) => b.position - a.position).map(serializeRole);
    },

    async 'guild.role.create'(p, ctx) {
      const input = parse(roleInput.extend({ name: z.string().min(1).max(100) }), p);
      const g = getGuild(ctx, input.guildId);
      requireBotPermission(g, PermissionFlagsBits.ManageRoles, 'Rollen verwalten');
      assertPermissionsGrantable(g, input.permissions);
      const role = await g.roles.create({
        name: input.name,
        color: (input.color as `#${string}`) ?? undefined,
        hoist: input.hoist,
        mentionable: input.mentionable,
        permissions: input.permissions ? BigInt(input.permissions) : [],
        reason: `Dashboard (${p.actorId ?? 'unbekannt'})`,
      });
      return serializeRole(role);
    },

    async 'guild.role.update'(p, ctx) {
      const input = parse(roleInput.extend({ roleId: snowflake }), p);
      const g = getGuild(ctx, input.guildId);
      requireBotPermission(g, PermissionFlagsBits.ManageRoles, 'Rollen verwalten');
      const role = g.roles.cache.get(input.roleId);
      if (!role) throw new RpcError('NOT_FOUND', 'Rolle nicht gefunden.');
      if (role.id !== g.id && !botCanManageRole(g, role.id)) throw new RpcError('HIERARCHY', 'Diese Rolle steht über der höchsten Rolle des Bots oder wird von einer Integration verwaltet.');
      assertPermissionsGrantable(g, input.permissions);
      const updated = await role.edit({
        name: role.id === g.id ? undefined : input.name,
        color: role.id === g.id ? undefined : (input.color as `#${string}` | undefined),
        hoist: input.hoist,
        mentionable: input.mentionable,
        permissions: input.permissions !== undefined ? BigInt(input.permissions) : undefined,
        reason: `Dashboard (${p.actorId ?? 'unbekannt'})`,
      });
      return serializeRole(updated);
    },

    async 'guild.role.delete'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, roleId: snowflake }), p);
      const g = getGuild(ctx, input.guildId);
      const role = g.roles.cache.get(input.roleId);
      if (!role) throw new RpcError('NOT_FOUND', 'Rolle nicht gefunden.');
      if (!botCanManageRole(g, role.id)) throw new RpcError('HIERARCHY', 'Der Bot kann diese Rolle nicht löschen.');
      await role.delete(`Dashboard (${p.actorId ?? 'unbekannt'})`);
      return { ok: true };
    },

    async 'guild.channel.permissions.set'(p, ctx) {
      const input = parse(
        z.object({
          guildId: snowflake,
          channelId: snowflake,
          targetId: snowflake,
          targetType: z.enum(['role', 'member']),
          allow: z.string().regex(/^\d+$/),
          deny: z.string().regex(/^\d+$/),
        }),
        p,
      );
      const g = getGuild(ctx, input.guildId);
      requireBotPermission(g, PermissionFlagsBits.ManageRoles, 'Rollen verwalten');
      const ch = g.channels.cache.get(input.channelId);
      if (!ch || ch.isThread()) throw new RpcError('NOT_FOUND', 'Kanal nicht gefunden.');
      const me = g.members.me!;
      if (!ch.permissionsFor(me).has(PermissionFlagsBits.ManageRoles)) throw new RpcError('MISSING_PERMISSIONS', 'Der Bot darf die Berechtigungen dieses Kanals nicht verwalten.');
      await ch.permissionOverwrites.edit(
        input.targetId,
        Object.fromEntries([
          ...new PermissionsBitField(BigInt(input.allow)).toArray().map((k) => [k, true]),
          ...new PermissionsBitField(BigInt(input.deny)).toArray().map((k) => [k, false]),
          // Nicht gesetzte Rechte auf "neutral" (null) zurücksetzen
          ...new PermissionsBitField(PermissionsBitField.All & ~(BigInt(input.allow) | BigInt(input.deny))).toArray().map((k) => [k, null]),
        ]),
        { type: input.targetType === 'role' ? OverwriteType.Role : OverwriteType.Member, reason: `Dashboard (${p.actorId ?? 'unbekannt'})` },
      );
      return { ok: true };
    },

    async 'guild.channel.permissions.delete'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, channelId: snowflake, targetId: snowflake }), p);
      const g = getGuild(ctx, input.guildId);
      const ch = g.channels.cache.get(input.channelId);
      if (!ch || ch.isThread()) throw new RpcError('NOT_FOUND', 'Kanal nicht gefunden.');
      if (!ch.permissionsFor(g.members.me!).has(PermissionFlagsBits.ManageRoles)) throw new RpcError('MISSING_PERMISSIONS', 'Der Bot darf die Berechtigungen dieses Kanals nicht verwalten.');
      await ch.permissionOverwrites.delete(input.targetId, `Dashboard (${p.actorId ?? 'unbekannt'})`);
      return { ok: true };
    },

    async 'guild.settings.update'(p, ctx) {
      const input = parse(
        z.object({
          guildId: snowflake,
          name: z.string().min(2).max(100).optional(),
          verificationLevel: z.nativeEnum(GuildVerificationLevel).optional(),
          explicitContentFilter: z.nativeEnum(GuildExplicitContentFilter).optional(),
          defaultMessageNotifications: z.nativeEnum(GuildDefaultMessageNotifications).optional(),
          systemChannelId: snowflake.nullable().optional(),
          afkChannelId: snowflake.nullable().optional(),
          afkTimeout: z.union([z.literal(60), z.literal(300), z.literal(900), z.literal(1800), z.literal(3600)]).optional(),
        }),
        p,
      );
      const g = getGuild(ctx, input.guildId);
      requireBotPermission(g, PermissionFlagsBits.ManageGuild, 'Server verwalten');
      const { guildId: _g, ...data } = input;
      await g.edit({ ...data, reason: `Dashboard (${p.actorId ?? 'unbekannt'})` });
      return { ok: true };
    },

    async 'guild.members.list'(p, ctx) {
      const input = parse(
        z.object({
          guildId: snowflake,
          query: z.string().max(100).default(''),
          roleId: snowflake.optional(),
          limit: z.number().int().min(1).max(200).default(50),
          offset: z.number().int().min(0).default(0),
          bots: z.enum(['all', 'humans', 'bots']).default('all'),
        }),
        p,
      );
      const g = getGuild(ctx, input.guildId);
      let members = [...g.members.cache.values()];
      if (input.query) {
        const q = input.query.toLowerCase();
        if (members.length < g.memberCount && members.length < 1000) {
          const found = await g.members.search({ query: input.query, limit: 100 }).catch(() => null);
          if (found) members = [...found.values()];
        }
        members = members.filter((m) => m.id === input.query || m.user.username.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q));
      }
      if (input.roleId) members = members.filter((m) => m.roles.cache.has(input.roleId!));
      if (input.bots === 'humans') members = members.filter((m) => !m.user.bot);
      if (input.bots === 'bots') members = members.filter((m) => m.user.bot);
      members.sort((a, b) => (b.joinedTimestamp ?? 0) - (a.joinedTimestamp ?? 0));
      return {
        total: members.length,
        cached: g.members.cache.size,
        memberCount: g.memberCount,
        items: members.slice(input.offset, input.offset + input.limit).map(serializeMember),
      };
    },

    async 'guild.member'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, userId: snowflake }), p);
      const g = getGuild(ctx, input.guildId);
      const m = await g.members.fetch(input.userId).catch(() => null);
      if (!m) {
        const user = await ctx.client.users.fetch(input.userId).catch(() => null);
        const ban = await g.bans.fetch(input.userId).catch(() => null);
        return user
          ? { inGuild: false, banned: !!ban, banReason: ban?.reason ?? null, id: user.id, username: user.username, displayName: user.globalName ?? user.username, avatar: user.displayAvatarURL({ size: 128 }), bot: user.bot, createdAt: user.createdAt.toISOString(), roles: [] }
          : null;
      }
      return { inGuild: true, banned: false, ...serializeMember(m), manageable: m.manageable, kickable: m.kickable, bannable: m.bannable, moderatable: m.moderatable };
    },

    async 'guild.member.roles'(p, ctx) {
      const input = parse(
        z.object({ guildId: snowflake, userId: snowflake, add: z.array(snowflake).max(25).default(() => []), remove: z.array(snowflake).max(25).default(() => []), actorId: z.string().optional() }),
        p,
      );
      const g = getGuild(ctx, input.guildId);
      requireBotPermission(g, PermissionFlagsBits.ManageRoles, 'Rollen verwalten');
      const m = await g.members.fetch(input.userId).catch(() => null);
      if (!m) throw new RpcError('NOT_FOUND', 'Mitglied nicht gefunden.');
      for (const id of [...input.add, ...input.remove]) {
        if (!botCanManageRole(g, id)) throw new RpcError('HIERARCHY', `Die Rolle ${g.roles.cache.get(id)?.name ?? id} kann der Bot nicht verwalten.`);
      }
      const reason = `Dashboard (${input.actorId ?? 'unbekannt'})`;
      if (input.add.length) await m.roles.add(input.add, reason);
      if (input.remove.length) await m.roles.remove(input.remove, reason);
      return serializeMember(await m.fetch(true));
    },

    /** Für Dashboard-Berechtigungen: Rollen und Rechte eines Nutzers auf einem Server. */
    async 'guild.member.access'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, userId: snowflake }), p);
      const g = ctx.client.guilds.cache.get(input.guildId);
      if (!g) return null;
      const m = await g.members.fetch(input.userId).catch(() => null);
      if (!m) return null;
      return { roles: [...m.roles.cache.keys()], permissions: m.permissions.bitfield.toString(), owner: g.ownerId === m.id };
    },

    async 'guild.user'(p, ctx) {
      const input = parse(z.object({ userId: snowflake }), p);
      const u = await ctx.client.users.fetch(input.userId).catch(() => null);
      return u ? { id: u.id, username: u.username, avatar: avatarUrl(u.id, u.avatar), bot: u.bot } : null;
    },

    async 'bot.guilds'(_p, ctx) {
      return ctx.client.guilds.cache.map((g) => g.id);
    },

    async 'guild.textChannelsFor'(p, ctx) {
      const g = getGuild(ctx, p.guildId);
      return g.channels.cache.filter((c) => c.type === ChannelType.GuildText).map((c) => ({ id: c.id, name: c.name }));
    },
  },
};
