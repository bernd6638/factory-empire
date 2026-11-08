import type { GuildMember, PartialGuildMember } from 'discord.js';
import { renderTemplate } from '../../shared/template';
import { RpcError } from '../../shared/bus';
import type { ModuleConfig } from '../../shared/modules';
import type { BotContext, BotModule } from '../core/types';
import { embed, hexToInt } from '../utils/embeds';
import { botCanManageRole, getSendableChannel } from '../utils/discord';
import { getGuild } from './core';

function vars(member: GuildMember | PartialGuildMember) {
  return {
    user: `<@${member.id}>`,
    username: member.user?.username ?? 'Unbekannt',
    userId: member.id,
    server: member.guild.name,
    memberCount: member.guild.memberCount,
    date: new Date().toLocaleDateString('de-DE'),
  };
}

async function sendWelcome(member: GuildMember, cfg: ModuleConfig<'welcome'>) {
  const ch = await getSendableChannel(member.guild, cfg.welcome.channelId);
  if (!ch) throw new RpcError('VALIDATION', 'Willkommenskanal nicht gesetzt oder keine Schreibrechte.');
  const text = renderTemplate(cfg.welcome.message, vars(member));
  if (cfg.welcome.embed) {
    await ch.send({
      content: `<@${member.id}>`,
      embeds: [embed(hexToInt(cfg.welcome.color)).setAuthor({ name: member.user.username, iconURL: member.displayAvatarURL() }).setDescription(text).setThumbnail(member.displayAvatarURL({ size: 256 }))],
      allowedMentions: { users: [member.id] },
    });
  } else {
    await ch.send({ content: text, allowedMentions: { users: [member.id] } });
  }
}

export const welcomeModule: BotModule = {
  id: 'welcome',
  events: {
    async guildMemberAdd(ctx, member) {
      const cfg = await ctx.config.ifEnabled(member.guild.id, 'welcome');
      if (!cfg) return;

      if (cfg.welcome.enabled && cfg.welcome.channelId) await sendWelcome(member, cfg).catch(() => undefined);
      if (cfg.dm.enabled && !member.user.bot) await member.send(renderTemplate(cfg.dm.message, vars(member))).catch(() => undefined);

      const roles = (member.user.bot ? cfg.autoroles.bots : cfg.autoroles.humans).filter((id) => botCanManageRole(member.guild, id));
      if (roles.length) {
        const give = async () => {
          const fresh = await member.guild.members.fetch(member.id).catch(() => null);
          if (fresh) await fresh.roles.add(roles, 'Automatische Rollenvergabe').catch(() => undefined);
        };
        if (cfg.autoroles.delaySeconds > 0) setTimeout(() => void give(), cfg.autoroles.delaySeconds * 1000);
        else await give();
      }
    },
    async guildMemberRemove(ctx, member) {
      const cfg = await ctx.config.ifEnabled(member.guild.id, 'welcome');
      if (!cfg || !cfg.leave.enabled) return;
      const ch = await getSendableChannel(member.guild, cfg.leave.channelId);
      await ch?.send({ content: renderTemplate(cfg.leave.message, vars(member)), allowedMentions: { parse: [] } }).catch(() => undefined);
    },
  },
  rpc: {
    async 'welcome.test'(p, ctx: BotContext) {
      const guild = getGuild(ctx, p.guildId);
      const member = await guild.members.fetch(String(p.actorId)).catch(() => null);
      if (!member) throw new RpcError('NOT_FOUND', 'Du musst Mitglied des Servers sein, um die Vorschau zu senden.');
      const { config } = await ctx.config.get(guild.id, 'welcome');
      await sendWelcome(member, config);
      return { ok: true };
    },
  },
};
