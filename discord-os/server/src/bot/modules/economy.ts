import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { prisma } from '../../shared/prisma';
import { RpcError } from '../../shared/bus';
import { formatDuration } from '../../shared/duration';
import type { ModuleConfig } from '../../shared/modules';
import type { BotContext, BotModule, ComponentInteraction } from '../core/types';
import { COLORS, embed, failure, success, truncate } from '../utils/embeds';
import { botCanManageRole } from '../utils/discord';
import { credit, debit, fmt, getAccount, randomInt } from '../services/economy';

type EcoConfig = ModuleConfig<'economy'>;
const messageCooldowns = new Map<string, number>();
const TRADE_TTL_MS = 10 * 60_000;

async function cfgFor(ctx: BotContext, guildId: string): Promise<EcoConfig> {
  return (await ctx.config.get(guildId, 'economy')).config;
}

function parseAmount(raw: string, available: number): number | null {
  const v = raw.trim().toLowerCase();
  if (['all', 'alles', 'max'].includes(v)) return available;
  const n = Number(v.replace(/[.\s]/g, ''));
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function reply(i: ChatInputCommandInteraction<'cached'>, e: ReturnType<typeof embed>, ephemeral = false) {
  await i.reply({ embeds: [e], allowedMentions: { parse: [] }, ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
}

// ─── Handel ───

async function executeTrade(ctx: BotContext, tradeId: number, acceptorId: string) {
  const trade = await prisma.trade.findUnique({ where: { id: tradeId } });
  if (!trade || trade.status !== 'PENDING') throw new RpcError('VALIDATION', 'Dieses Angebot ist nicht mehr gültig.');
  if (trade.toUserId !== acceptorId) throw new RpcError('FORBIDDEN', 'Nur der Empfänger kann dieses Angebot annehmen.');
  if (Date.now() - trade.createdAt.getTime() > TRADE_TTL_MS) {
    await prisma.trade.update({ where: { id: trade.id }, data: { status: 'EXPIRED', resolvedAt: new Date() } });
    throw new RpcError('VALIDATION', 'Dieses Angebot ist abgelaufen.');
  }
  const cfg = await cfgFor(ctx, trade.guildId);
  await getAccount(trade.guildId, trade.toUserId, cfg);

  await prisma.$transaction(async (tx) => {
    const g = trade.guildId;
    const moveItem = async (from: string, to: string, itemId: number, qty: number) => {
      const res = await tx.inventoryItem.updateMany({ where: { guildId: g, userId: from, itemId, quantity: { gte: qty } }, data: { quantity: { decrement: qty } } });
      if (res.count === 0) throw new RpcError('INSUFFICIENT_ITEMS', 'Ein Teilnehmer besitzt die angebotenen Gegenstände nicht mehr.');
      await tx.inventoryItem.deleteMany({ where: { guildId: g, userId: from, itemId, quantity: { lte: 0 } } });
      await tx.inventoryItem.upsert({ where: { guildId_userId_itemId: { guildId: g, userId: to, itemId } }, create: { guildId: g, userId: to, itemId, quantity: qty }, update: { quantity: { increment: qty } } });
    };
    if (trade.offerMoney > 0) {
      await debit(tx, g, trade.fromUserId, trade.offerMoney);
      await tx.economyAccount.update({ where: { guildId_userId: { guildId: g, userId: trade.toUserId } }, data: { wallet: { increment: trade.offerMoney } } });
    }
    if (trade.requestMoney > 0) {
      await debit(tx, g, trade.toUserId, trade.requestMoney);
      await tx.economyAccount.update({ where: { guildId_userId: { guildId: g, userId: trade.fromUserId } }, data: { wallet: { increment: trade.requestMoney } } });
    }
    if (trade.offerItemId && trade.offerQty > 0) await moveItem(trade.fromUserId, trade.toUserId, trade.offerItemId, trade.offerQty);
    if (trade.requestItemId && trade.requestQty > 0) await moveItem(trade.toUserId, trade.fromUserId, trade.requestItemId, trade.requestQty);
    await tx.trade.update({ where: { id: trade.id }, data: { status: 'ACCEPTED', resolvedAt: new Date() } });
    await tx.transaction.create({
      data: { guildId: g, type: 'TRADE', fromUserId: trade.fromUserId, toUserId: trade.toUserId, amount: trade.offerMoney - trade.requestMoney, note: `Handel #${trade.id}` },
    });
  });
  ctx.live(trade.guildId, 'economy.trade', { id: trade.id, status: 'ACCEPTED' });
}

async function describeTrade(trade: { offerMoney: number; offerItemId: number | null; offerQty: number; requestMoney: number; requestItemId: number | null; requestQty: number }, cfg: EcoConfig) {
  const ids = [trade.offerItemId, trade.requestItemId].filter((x): x is number => !!x);
  const items = new Map((await prisma.shopItem.findMany({ where: { id: { in: ids } } })).map((it) => [it.id, it]));
  const side = (money: number, itemId: number | null, qty: number) =>
    [money > 0 ? fmt(money, cfg) : null, itemId && qty > 0 ? `${qty}× ${items.get(itemId)?.emoji ?? ''} ${items.get(itemId)?.name ?? 'Gegenstand'}` : null].filter(Boolean).join('\n') || '—';
  return { offer: side(trade.offerMoney, trade.offerItemId, trade.offerQty), request: side(trade.requestMoney, trade.requestItemId, trade.requestQty) };
}

async function handleComponent(i: ComponentInteraction, args: string[], ctx: BotContext) {
  const [action, rawId] = args;
  if (!i.isButton()) return;
  const id = Number(rawId);
  const trade = await prisma.trade.findUnique({ where: { id } });
  if (!trade || trade.guildId !== i.guildId) throw new RpcError('NOT_FOUND', 'Angebot nicht gefunden.');

  if (action === 'accept') {
    await executeTrade(ctx, id, i.user.id);
    await i.update({ embeds: [success(`Handel #${id} wurde abgeschlossen. <@${trade.fromUserId}> ⇄ <@${trade.toUserId}>`)], components: [] });
  } else if (action === 'decline') {
    if (i.user.id !== trade.toUserId && i.user.id !== trade.fromUserId) throw new RpcError('FORBIDDEN', 'Das ist nicht dein Handel.');
    if (trade.status !== 'PENDING') throw new RpcError('VALIDATION', 'Dieses Angebot ist nicht mehr gültig.');
    const status = i.user.id === trade.fromUserId ? 'CANCELLED' : 'DECLINED';
    await prisma.trade.update({ where: { id }, data: { status, resolvedAt: new Date() } });
    await i.update({ embeds: [failure(`Handel #${id} wurde ${status === 'CANCELLED' ? 'zurückgezogen' : 'abgelehnt'}.`)], components: [] });
  }
}

async function itemAutocomplete(i: Parameters<NonNullable<BotModule['commands']>[number]['autocomplete'] & {}>[0], owned: boolean) {
  const q = String(i.options.getFocused()).toLowerCase();
  if (owned) {
    const inv = await prisma.inventoryItem.findMany({ where: { guildId: i.guildId, userId: i.user.id }, include: { item: true }, take: 25 });
    await i.respond(inv.filter((x) => x.item.name.toLowerCase().includes(q)).map((x) => ({ name: `${x.item.name} (${x.quantity}×)`, value: String(x.itemId) })));
    return;
  }
  const items = await prisma.shopItem.findMany({ where: { guildId: i.guildId, enabled: true, name: { contains: q, mode: 'insensitive' } }, take: 25, orderBy: { price: 'asc' } });
  await i.respond(items.map((it) => ({ name: truncate(`${it.name} – ${it.price}`, 100), value: String(it.id) })));
}

export const economyModule: BotModule = {
  id: 'economy',
  components: [{ prefix: 'trade', handle: handleComponent }],

  events: {
    async messageCreate(ctx, message) {
      if (!message.inGuild() || message.author.bot || message.system) return;
      const cfg = await ctx.config.ifEnabled(message.guildId, 'economy');
      if (!cfg || !cfg.messageReward.enabled) return;
      const key = `${message.guildId}:${message.author.id}`;
      if (Date.now() - (messageCooldowns.get(key) ?? 0) < cfg.messageReward.cooldownSeconds * 1000) return;
      messageCooldowns.set(key, Date.now());
      if (messageCooldowns.size > 100_000) messageCooldowns.clear();
      await credit(message.guildId, message.author.id, randomInt(cfg.messageReward.min, cfg.messageReward.max), 'MESSAGE', cfg);
    },
  },

  jobs: [
    {
      name: 'expire-trades',
      intervalMs: 60_000,
      async run() {
        await prisma.trade.updateMany({ where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - TRADE_TTL_MS) } }, data: { status: 'EXPIRED', resolvedAt: new Date() } });
      },
    },
  ],

  commands: [
    {
      data: new SlashCommandBuilder().setName('balance').setDescription('Zeigt den Kontostand').addUserOption((o) => o.setName('mitglied').setDescription('Anderes Mitglied')).toJSON(),
      async execute(i, ctx) {
        const cfg = await cfgFor(ctx, i.guildId);
        const user = i.options.getUser('mitglied') ?? i.user;
        if (user.bot) throw new RpcError('VALIDATION', 'Bots haben kein Konto.');
        const acc = await getAccount(i.guildId, user.id, cfg);
        const rank = (await prisma.economyAccount.count({ where: { guildId: i.guildId, wallet: { gt: acc.wallet } } })) + 1;
        await reply(
          i,
          embed(COLORS.warning)
            .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
            .addFields(
              { name: 'Wallet', value: fmt(acc.wallet, cfg), inline: true },
              { name: 'Bank', value: fmt(acc.bank, cfg), inline: true },
              { name: 'Gesamt', value: fmt(acc.wallet + acc.bank, cfg), inline: true },
              { name: 'Job', value: acc.job ? `${acc.job.emoji ?? ''} ${acc.job.name}` : 'Arbeitslos', inline: true },
              { name: 'Firma', value: acc.company?.name ?? '—', inline: true },
              { name: 'Rang (Wallet)', value: `#${rank}`, inline: true },
            ),
        );
      },
    },
    {
      data: new SlashCommandBuilder().setName('daily').setDescription('Tägliche Belohnung abholen').toJSON(),
      async execute(i, ctx) {
        const cfg = await cfgFor(ctx, i.guildId);
        const acc = await getAccount(i.guildId, i.user.id, cfg);
        const now = Date.now();
        const last = acc.lastDaily?.getTime() ?? 0;
        if (now - last < 20 * 3_600_000) {
          await reply(i, failure(`Du hast deine tägliche Belohnung bereits abgeholt. Wieder verfügbar in **${formatDuration(20 * 3_600_000 - (now - last))}**.`), true);
          return;
        }
        const streak = now - last < 48 * 3_600_000 ? Math.min(acc.dailyStreak + 1, cfg.daily.maxStreak) : 1;
        const amount = cfg.daily.amount + (streak - 1) * cfg.daily.streakBonus;
        const res = await prisma.economyAccount.updateMany({
          where: { guildId: i.guildId, userId: i.user.id, OR: [{ lastDaily: null }, { lastDaily: { lt: new Date(now - 20 * 3_600_000) } }] },
          data: { wallet: { increment: amount }, totalEarned: { increment: amount }, lastDaily: new Date(now), dailyStreak: streak },
        });
        if (res.count === 0) throw new RpcError('COOLDOWN', 'Bereits abgeholt.');
        await prisma.transaction.create({ data: { guildId: i.guildId, type: 'DAILY', toUserId: i.user.id, amount, note: `Streak ${streak}` } });
        await reply(i, success(`Du erhältst **${fmt(amount, cfg)}**! 🔥 Streak: **${streak}** Tag(e)`));
      },
    },
    {
      data: new SlashCommandBuilder().setName('work').setDescription('Arbeiten und Geld verdienen').toJSON(),
      async execute(i, ctx) {
        const cfg = await cfgFor(ctx, i.guildId);
        const acc = await getAccount(i.guildId, i.user.id, cfg);
        const cooldownMs = cfg.work.cooldownMinutes * 60_000;
        const elapsed = Date.now() - (acc.lastWork?.getTime() ?? 0);
        if (elapsed < cooldownMs) {
          await reply(i, failure(`Du bist noch erschöpft. Wieder arbeiten in **${formatDuration(cooldownMs - elapsed)}**.`), true);
          return;
        }
        const amount = acc.job ? randomInt(acc.job.minPay, acc.job.maxPay) : randomInt(cfg.work.min, cfg.work.max);
        const res = await prisma.economyAccount.updateMany({
          where: { guildId: i.guildId, userId: i.user.id, OR: [{ lastWork: null }, { lastWork: { lt: new Date(Date.now() - cooldownMs) } }] },
          data: { wallet: { increment: amount }, totalEarned: { increment: amount }, lastWork: new Date() },
        });
        if (res.count === 0) throw new RpcError('COOLDOWN', 'Du arbeitest bereits.');
        await prisma.transaction.create({ data: { guildId: i.guildId, type: 'WORK', toUserId: i.user.id, amount, note: acc.job?.name ?? 'Gelegenheitsjob' } });
        let bonusText = '';
        if (acc.companyId && cfg.companyBonusPercent > 0) {
          const bonus = Math.floor((amount * cfg.companyBonusPercent) / 100);
          if (bonus > 0) {
            await prisma.company.update({ where: { id: acc.companyId }, data: { balance: { increment: bonus } } });
            await prisma.transaction.create({ data: { guildId: i.guildId, type: 'COMPANY', fromUserId: i.user.id, amount: bonus, note: `Firmenbonus ${acc.company?.name ?? ''}` } });
            bonusText = `\n🏢 Deine Firma **${acc.company?.name}** erhält zusätzlich ${fmt(bonus, cfg)}.`;
          }
        }
        await reply(i, success(`Du hast ${acc.job ? `als **${acc.job.name}**` : 'einen Gelegenheitsjob'} gearbeitet und **${fmt(amount, cfg)}** verdient.${bonusText}`));
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('pay')
        .setDescription('Überweist Geld an ein Mitglied')
        .addUserOption((o) => o.setName('mitglied').setDescription('Empfänger').setRequired(true))
        .addIntegerOption((o) => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1))
        .toJSON(),
      async execute(i, ctx) {
        const cfg = await cfgFor(ctx, i.guildId);
        const target = i.options.getUser('mitglied', true);
        const amount = i.options.getInteger('betrag', true);
        if (target.bot || target.id === i.user.id) throw new RpcError('VALIDATION', 'Ungültiger Empfänger.');
        const tax = Math.floor((amount * cfg.transferTaxPercent) / 100);
        await getAccount(i.guildId, i.user.id, cfg);
        await getAccount(i.guildId, target.id, cfg);
        await prisma.$transaction(async (tx) => {
          await debit(tx, i.guildId, i.user.id, amount);
          await tx.economyAccount.update({ where: { guildId_userId: { guildId: i.guildId, userId: target.id } }, data: { wallet: { increment: amount - tax } } });
          await tx.transaction.create({ data: { guildId: i.guildId, type: 'TRANSFER', fromUserId: i.user.id, toUserId: target.id, amount: amount - tax, note: tax ? `Steuer: ${tax}` : null } });
        });
        await reply(i, success(`Du hast **${fmt(amount - tax, cfg)}** an <@${target.id}> überwiesen.${tax ? ` (Steuer: ${fmt(tax, cfg)})` : ''}`));
      },
    },
    {
      data: new SlashCommandBuilder().setName('deposit').setDescription('Geld auf die Bank einzahlen').addStringOption((o) => o.setName('betrag').setDescription('Betrag oder "alles"').setRequired(true)).toJSON(),
      async execute(i, ctx) {
        const cfg = await cfgFor(ctx, i.guildId);
        const acc = await getAccount(i.guildId, i.user.id, cfg);
        const amount = parseAmount(i.options.getString('betrag', true), acc.wallet);
        if (!amount) throw new RpcError('VALIDATION', 'Ungültiger Betrag.');
        await prisma.$transaction(async (tx) => {
          await debit(tx, i.guildId, i.user.id, amount);
          await tx.economyAccount.update({ where: { guildId_userId: { guildId: i.guildId, userId: i.user.id } }, data: { bank: { increment: amount } } });
          await tx.transaction.create({ data: { guildId: i.guildId, type: 'DEPOSIT', fromUserId: i.user.id, amount } });
        });
        await reply(i, success(`**${fmt(amount, cfg)}** eingezahlt.`), true);
      },
    },
    {
      data: new SlashCommandBuilder().setName('withdraw').setDescription('Geld von der Bank abheben').addStringOption((o) => o.setName('betrag').setDescription('Betrag oder "alles"').setRequired(true)).toJSON(),
      async execute(i, ctx) {
        const cfg = await cfgFor(ctx, i.guildId);
        const acc = await getAccount(i.guildId, i.user.id, cfg);
        const amount = parseAmount(i.options.getString('betrag', true), acc.bank);
        if (!amount) throw new RpcError('VALIDATION', 'Ungültiger Betrag.');
        const res = await prisma.economyAccount.updateMany({ where: { guildId: i.guildId, userId: i.user.id, bank: { gte: amount } }, data: { bank: { decrement: amount }, wallet: { increment: amount } } });
        if (res.count === 0) throw new RpcError('INSUFFICIENT_FUNDS', 'Nicht genügend Guthaben auf der Bank.');
        await prisma.transaction.create({ data: { guildId: i.guildId, type: 'WITHDRAW', toUserId: i.user.id, amount } });
        await reply(i, success(`**${fmt(amount, cfg)}** abgehoben.`), true);
      },
    },
    {
      data: new SlashCommandBuilder().setName('shop').setDescription('Zeigt den Shop').toJSON(),
      async execute(i, ctx) {
        const cfg = await cfgFor(ctx, i.guildId);
        const items = await prisma.shopItem.findMany({ where: { guildId: i.guildId, enabled: true }, orderBy: { price: 'asc' }, take: 25 });
        await reply(
          i,
          embed(COLORS.warning)
            .setTitle('🛒 Shop')
            .setDescription(
              items.length
                ? items
                    .map((it) => `${it.emoji ?? '📦'} **${it.name}** – ${fmt(it.price, cfg)}${it.stock !== null ? ` • Bestand: ${it.stock}` : ''}${it.roleId ? ` • Rolle <@&${it.roleId}>` : ''}\n└ ${it.description ?? ''}`)
                    .join('\n')
                : 'Der Shop ist leer.',
            )
            .setFooter({ text: 'Kaufen mit /buy' }),
        );
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('buy')
        .setDescription('Kauft einen Gegenstand aus dem Shop')
        .addStringOption((o) => o.setName('gegenstand').setDescription('Gegenstand').setRequired(true).setAutocomplete(true))
        .addIntegerOption((o) => o.setName('menge').setDescription('Menge').setMinValue(1).setMaxValue(100))
        .toJSON(),
      autocomplete: (i) => itemAutocomplete(i, false),
      async execute(i, ctx) {
        const cfg = await cfgFor(ctx, i.guildId);
        const id = Number(i.options.getString('gegenstand', true));
        const qty = i.options.getInteger('menge') ?? 1;
        const item = Number.isInteger(id) ? await prisma.shopItem.findFirst({ where: { id, guildId: i.guildId, enabled: true } }) : null;
        if (!item) throw new RpcError('NOT_FOUND', 'Gegenstand nicht gefunden. Wähle einen Eintrag aus der Liste.');
        if (item.roleId && qty > 1) throw new RpcError('VALIDATION', 'Rollen können nur einmal gekauft werden.');
        if (item.roleId) {
          if (i.member.roles.cache.has(item.roleId)) throw new RpcError('VALIDATION', 'Du besitzt diese Rolle bereits.');
          if (!botCanManageRole(i.guild, item.roleId)) throw new RpcError('HIERARCHY', 'Der Bot kann diese Rolle derzeit nicht vergeben. Bitte informiere das Team.');
        }
        const total = item.price * qty;
        await getAccount(i.guildId, i.user.id, cfg);
        await prisma.$transaction(async (tx) => {
          if (item.stock !== null) {
            const res = await tx.shopItem.updateMany({ where: { id: item.id, stock: { gte: qty } }, data: { stock: { decrement: qty } } });
            if (res.count === 0) throw new RpcError('OUT_OF_STOCK', 'Nicht genügend Bestand.');
          }
          await debit(tx, i.guildId, i.user.id, total);
          await tx.inventoryItem.upsert({
            where: { guildId_userId_itemId: { guildId: i.guildId, userId: i.user.id, itemId: item.id } },
            create: { guildId: i.guildId, userId: i.user.id, itemId: item.id, quantity: qty },
            update: { quantity: { increment: qty } },
          });
          await tx.transaction.create({ data: { guildId: i.guildId, type: 'PURCHASE', fromUserId: i.user.id, amount: total, note: `${qty}× ${item.name}` } });
        });
        if (item.roleId) await i.member.roles.add(item.roleId, `Shop-Kauf: ${item.name}`).catch(() => undefined);
        ctx.live(i.guildId, 'economy.purchase', { userId: i.user.id, item: item.name, qty, total });
        await reply(i, success(`Du hast **${qty}× ${item.emoji ?? ''} ${item.name}** für **${fmt(total, cfg)}** gekauft.${item.roleId ? ` Rolle <@&${item.roleId}> erhalten!` : ''}`));
      },
    },
    {
      data: new SlashCommandBuilder().setName('inventory').setDescription('Zeigt das Inventar').addUserOption((o) => o.setName('mitglied').setDescription('Anderes Mitglied')).toJSON(),
      async execute(i) {
        const user = i.options.getUser('mitglied') ?? i.user;
        const inv = await prisma.inventoryItem.findMany({ where: { guildId: i.guildId, userId: user.id, quantity: { gt: 0 } }, include: { item: true } });
        await reply(i, embed(COLORS.warning).setTitle(`🎒 Inventar von ${user.username}`).setDescription(inv.length ? inv.map((x) => `${x.item.emoji ?? '📦'} **${x.item.name}** × ${x.quantity}`).join('\n') : 'Leer.'));
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('trade')
        .setDescription('Bietet einem Mitglied einen Handel an')
        .addUserOption((o) => o.setName('mitglied').setDescription('Handelspartner').setRequired(true))
        .addIntegerOption((o) => o.setName('biete_geld').setDescription('Angebotenes Geld').setMinValue(0))
        .addStringOption((o) => o.setName('biete_item').setDescription('Angebotener Gegenstand').setAutocomplete(true))
        .addIntegerOption((o) => o.setName('biete_menge').setDescription('Menge des Gegenstands').setMinValue(1).setMaxValue(1000))
        .addIntegerOption((o) => o.setName('fordere_geld').setDescription('Gefordertes Geld').setMinValue(0))
        .addStringOption((o) => o.setName('fordere_item').setDescription('Geforderter Gegenstand (aus dem Shop)').setAutocomplete(true))
        .addIntegerOption((o) => o.setName('fordere_menge').setDescription('Geforderte Menge').setMinValue(1).setMaxValue(1000))
        .toJSON(),
      async autocomplete(i) {
        const focused = i.options.getFocused(true);
        if (focused.name === 'biete_item') return itemAutocomplete(i, true);
        const q = String(focused.value).toLowerCase();
        const items = await prisma.shopItem.findMany({ where: { guildId: i.guildId, tradable: true, name: { contains: q, mode: 'insensitive' } }, take: 25 });
        await i.respond(items.map((it) => ({ name: it.name, value: String(it.id) })));
      },
      async execute(i, ctx) {
        const cfg = await cfgFor(ctx, i.guildId);
        const target = i.options.getUser('mitglied', true);
        if (target.bot || target.id === i.user.id) throw new RpcError('VALIDATION', 'Ungültiger Handelspartner.');
        const offerMoney = i.options.getInteger('biete_geld') ?? 0;
        const requestMoney = i.options.getInteger('fordere_geld') ?? 0;
        const offerItemRaw = i.options.getString('biete_item');
        const requestItemRaw = i.options.getString('fordere_item');
        const offerItemId = offerItemRaw ? Number(offerItemRaw) : null;
        const requestItemId = requestItemRaw ? Number(requestItemRaw) : null;
        const offerQty = offerItemId ? i.options.getInteger('biete_menge') ?? 1 : 0;
        const requestQty = requestItemId ? i.options.getInteger('fordere_menge') ?? 1 : 0;
        if (!offerMoney && !offerItemId && !requestMoney && !requestItemId) throw new RpcError('VALIDATION', 'Ein Handel braucht mindestens ein Angebot oder eine Forderung.');
        for (const id of [offerItemId, requestItemId]) {
          if (id === null) continue;
          const it = Number.isInteger(id) ? await prisma.shopItem.findFirst({ where: { id, guildId: i.guildId } }) : null;
          if (!it) throw new RpcError('NOT_FOUND', 'Gegenstand nicht gefunden.');
          if (!it.tradable) throw new RpcError('VALIDATION', `${it.name} kann nicht gehandelt werden.`);
        }
        const acc = await getAccount(i.guildId, i.user.id, cfg);
        if (acc.wallet < offerMoney) throw new RpcError('INSUFFICIENT_FUNDS', 'Du hast nicht genug Geld für dieses Angebot.');
        if (offerItemId) {
          const own = await prisma.inventoryItem.findUnique({ where: { guildId_userId_itemId: { guildId: i.guildId, userId: i.user.id, itemId: offerItemId } } });
          if (!own || own.quantity < offerQty) throw new RpcError('INSUFFICIENT_ITEMS', 'Du besitzt nicht genug von diesem Gegenstand.');
        }
        const trade = await prisma.trade.create({ data: { guildId: i.guildId, fromUserId: i.user.id, toUserId: target.id, offerMoney, offerItemId, offerQty, requestMoney, requestItemId, requestQty } });
        const d = await describeTrade(trade, cfg);
        await i.reply({
          content: `<@${target.id}>, du hast ein Handelsangebot erhalten!`,
          embeds: [
            embed(COLORS.violet)
              .setTitle(`🤝 Handel #${trade.id}`)
              .setDescription(`<@${i.user.id}> möchte mit dir handeln. Gültig für 10 Minuten.`)
              .addFields({ name: `${i.user.username} bietet`, value: d.offer, inline: true }, { name: 'Fordert dafür', value: d.request, inline: true }),
          ],
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId(`trade:accept:${trade.id}`).setLabel('Annehmen').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`trade:decline:${trade.id}`).setLabel('Ablehnen').setStyle(ButtonStyle.Danger),
            ),
          ],
          allowedMentions: { users: [target.id] },
        });
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('job')
        .setDescription('Jobs verwalten')
        .addSubcommand((s) => s.setName('list').setDescription('Verfügbare Jobs anzeigen'))
        .addSubcommand((s) => s.setName('join').setDescription('Einen Job annehmen').addStringOption((o) => o.setName('job').setDescription('Job').setRequired(true).setAutocomplete(true)))
        .addSubcommand((s) => s.setName('quit').setDescription('Job kündigen'))
        .toJSON(),
      async autocomplete(i) {
        const q = String(i.options.getFocused()).toLowerCase();
        const jobs = await prisma.job.findMany({ where: { guildId: i.guildId, name: { contains: q, mode: 'insensitive' } }, take: 25, orderBy: { requiredLevel: 'asc' } });
        await i.respond(jobs.map((j) => ({ name: `${j.name} (ab Level ${j.requiredLevel})`, value: String(j.id) })));
      },
      async execute(i, ctx) {
        const cfg = await cfgFor(ctx, i.guildId);
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const jobs = await prisma.job.findMany({ where: { guildId: i.guildId }, orderBy: { requiredLevel: 'asc' } });
          await reply(
            i,
            embed(COLORS.warning)
              .setTitle('💼 Jobs')
              .setDescription(jobs.length ? jobs.map((j) => `${j.emoji ?? '💼'} **${j.name}** – ${fmt(j.minPay, cfg)} bis ${fmt(j.maxPay, cfg)} • ab Level ${j.requiredLevel}\n└ ${j.description ?? ''}`).join('\n') : 'Es gibt noch keine Jobs.'),
          );
          return;
        }
        await getAccount(i.guildId, i.user.id, cfg);
        if (sub === 'quit') {
          await prisma.economyAccount.update({ where: { guildId_userId: { guildId: i.guildId, userId: i.user.id } }, data: { jobId: null } });
          await reply(i, success('Du hast deinen Job gekündigt.'), true);
          return;
        }
        const id = Number(i.options.getString('job', true));
        const job = Number.isInteger(id) ? await prisma.job.findFirst({ where: { id, guildId: i.guildId } }) : null;
        if (!job) throw new RpcError('NOT_FOUND', 'Job nicht gefunden.');
        const profile = await prisma.memberProfile.findUnique({ where: { guildId_userId: { guildId: i.guildId, userId: i.user.id } } });
        if ((profile?.level ?? 0) < job.requiredLevel) throw new RpcError('VALIDATION', `Für diesen Job brauchst du mindestens Level ${job.requiredLevel}.`);
        await prisma.economyAccount.update({ where: { guildId_userId: { guildId: i.guildId, userId: i.user.id } }, data: { jobId: job.id } });
        await reply(i, success(`Du arbeitest jetzt als **${job.emoji ?? ''} ${job.name}**. Nutze /work!`));
      },
    },
    {
      data: new SlashCommandBuilder()
        .setName('company')
        .setDescription('Firmen verwalten')
        .addSubcommand((s) => s.setName('create').setDescription('Eine Firma gründen').addStringOption((o) => o.setName('name').setDescription('Firmenname').setRequired(true).setMinLength(3).setMaxLength(32)))
        .addSubcommand((s) => s.setName('info').setDescription('Firmeninfo').addStringOption((o) => o.setName('name').setDescription('Firmenname (leer = eigene)').setAutocomplete(true)))
        .addSubcommand((s) => s.setName('join').setDescription('Einer offenen Firma beitreten').addStringOption((o) => o.setName('name').setDescription('Firmenname').setRequired(true).setAutocomplete(true)))
        .addSubcommand((s) => s.setName('leave').setDescription('Die Firma verlassen'))
        .addSubcommand((s) => s.setName('deposit').setDescription('Geld in die Firmenkasse einzahlen').addIntegerOption((o) => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1)))
        .addSubcommand((s) =>
          s
            .setName('payout')
            .setDescription('Geld aus der Firmenkasse auszahlen (nur Inhaber)')
            .addUserOption((o) => o.setName('mitglied').setDescription('Empfänger').setRequired(true))
            .addIntegerOption((o) => o.setName('betrag').setDescription('Betrag').setRequired(true).setMinValue(1)),
        )
        .addSubcommand((s) => s.setName('toggle').setDescription('Firma für neue Mitglieder öffnen/schließen (nur Inhaber)'))
        .toJSON(),
      async autocomplete(i) {
        const q = String(i.options.getFocused()).toLowerCase();
        const list = await prisma.company.findMany({ where: { guildId: i.guildId, name: { contains: q, mode: 'insensitive' } }, take: 25 });
        await i.respond(list.map((c) => ({ name: c.name, value: c.name })));
      },
      async execute(i, ctx) {
        const cfg = await cfgFor(ctx, i.guildId);
        const sub = i.options.getSubcommand();
        const acc = await getAccount(i.guildId, i.user.id, cfg);

        if (sub === 'create') {
          if (acc.companyId) throw new RpcError('VALIDATION', 'Du bist bereits in einer Firma.');
          const name = i.options.getString('name', true).trim();
          if (await prisma.company.findUnique({ where: { guildId_name: { guildId: i.guildId, name } } })) throw new RpcError('VALIDATION', 'Dieser Name ist bereits vergeben.');
          await prisma.$transaction(async (tx) => {
            if (cfg.companyCreateCost > 0) await debit(tx, i.guildId, i.user.id, cfg.companyCreateCost);
            const company = await tx.company.create({ data: { guildId: i.guildId, name, ownerId: i.user.id } });
            await tx.economyAccount.update({ where: { guildId_userId: { guildId: i.guildId, userId: i.user.id } }, data: { companyId: company.id } });
            if (cfg.companyCreateCost > 0) await tx.transaction.create({ data: { guildId: i.guildId, type: 'COMPANY', fromUserId: i.user.id, amount: cfg.companyCreateCost, note: `Gründung ${name}` } });
          });
          await reply(i, success(`🏢 Firma **${name}** gegründet${cfg.companyCreateCost ? ` (Kosten: ${fmt(cfg.companyCreateCost, cfg)})` : ''}.`));
          return;
        }

        if (sub === 'info') {
          const name = i.options.getString('name');
          const company = name
            ? await prisma.company.findUnique({ where: { guildId_name: { guildId: i.guildId, name } }, include: { members: true } })
            : acc.companyId
              ? await prisma.company.findUnique({ where: { id: acc.companyId }, include: { members: true } })
              : null;
          if (!company) throw new RpcError('NOT_FOUND', 'Firma nicht gefunden.');
          await reply(
            i,
            embed(COLORS.warning)
              .setTitle(`🏢 ${company.name}`)
              .addFields(
                { name: 'Inhaber', value: `<@${company.ownerId}>`, inline: true },
                { name: 'Kasse', value: fmt(company.balance, cfg), inline: true },
                { name: 'Status', value: company.open ? 'Offen' : 'Geschlossen', inline: true },
                { name: `Mitglieder (${company.members.length}/${cfg.maxCompanyMembers})`, value: company.members.map((m) => `<@${m.userId}>`).join(', ') || '—' },
              ),
          );
          return;
        }

        if (sub === 'join') {
          if (acc.companyId) throw new RpcError('VALIDATION', 'Du bist bereits in einer Firma.');
          const company = await prisma.company.findUnique({ where: { guildId_name: { guildId: i.guildId, name: i.options.getString('name', true) } }, include: { _count: { select: { members: true } } } });
          if (!company) throw new RpcError('NOT_FOUND', 'Firma nicht gefunden.');
          if (!company.open) throw new RpcError('VALIDATION', 'Diese Firma nimmt derzeit keine Mitglieder auf.');
          if (company._count.members >= cfg.maxCompanyMembers) throw new RpcError('LIMIT', 'Diese Firma ist voll.');
          await prisma.economyAccount.update({ where: { guildId_userId: { guildId: i.guildId, userId: i.user.id } }, data: { companyId: company.id } });
          await reply(i, success(`Du bist **${company.name}** beigetreten.`));
          return;
        }

        if (!acc.companyId || !acc.company) throw new RpcError('VALIDATION', 'Du bist in keiner Firma.');
        const company = acc.company;
        const isOwner = company.ownerId === i.user.id;

        if (sub === 'leave') {
          if (isOwner) {
            const others = await prisma.economyAccount.count({ where: { companyId: company.id, NOT: { userId: i.user.id } } });
            if (others > 0) throw new RpcError('VALIDATION', 'Als Inhaber musst du zuerst alle Mitglieder auszahlen bzw. die Firma leeren.');
            // Restguthaben an den Inhaber, dann Firma auflösen
            if (company.balance > 0) await credit(i.guildId, i.user.id, company.balance, 'COMPANY', cfg, `Auflösung ${company.name}`);
            await prisma.company.delete({ where: { id: company.id } });
            await reply(i, success(`Firma **${company.name}** wurde aufgelöst.`));
            return;
          }
          await prisma.economyAccount.update({ where: { guildId_userId: { guildId: i.guildId, userId: i.user.id } }, data: { companyId: null } });
          await reply(i, success(`Du hast **${company.name}** verlassen.`));
          return;
        }

        if (sub === 'deposit') {
          const amount = i.options.getInteger('betrag', true);
          await prisma.$transaction(async (tx) => {
            await debit(tx, i.guildId, i.user.id, amount);
            await tx.company.update({ where: { id: company.id }, data: { balance: { increment: amount } } });
            await tx.transaction.create({ data: { guildId: i.guildId, type: 'COMPANY', fromUserId: i.user.id, amount, note: `Einzahlung ${company.name}` } });
          });
          await reply(i, success(`**${fmt(amount, cfg)}** in die Kasse von **${company.name}** eingezahlt.`));
          return;
        }

        if (!isOwner) throw new RpcError('FORBIDDEN', 'Nur der Inhaber kann das.');

        if (sub === 'toggle') {
          const updated = await prisma.company.update({ where: { id: company.id }, data: { open: !company.open } });
          await reply(i, success(`**${company.name}** ist jetzt ${updated.open ? 'offen' : 'geschlossen'}.`), true);
          return;
        }

        if (sub === 'payout') {
          const target = i.options.getUser('mitglied', true);
          const amount = i.options.getInteger('betrag', true);
          const targetAcc = await prisma.economyAccount.findUnique({ where: { guildId_userId: { guildId: i.guildId, userId: target.id } } });
          if (targetAcc?.companyId !== company.id) throw new RpcError('VALIDATION', 'Der Empfänger ist kein Mitglied deiner Firma.');
          await prisma.$transaction(async (tx) => {
            const res = await tx.company.updateMany({ where: { id: company.id, balance: { gte: amount } }, data: { balance: { decrement: amount } } });
            if (res.count === 0) throw new RpcError('INSUFFICIENT_FUNDS', 'Nicht genug Geld in der Firmenkasse.');
            await tx.economyAccount.update({ where: { guildId_userId: { guildId: i.guildId, userId: target.id } }, data: { wallet: { increment: amount }, totalEarned: { increment: amount } } });
            await tx.transaction.create({ data: { guildId: i.guildId, type: 'COMPANY', toUserId: target.id, amount, note: `Auszahlung ${company.name}` } });
          });
          await reply(i, success(`**${fmt(amount, cfg)}** an <@${target.id}> ausgezahlt.`));
        }
      },
    },
    {
      data: new SlashCommandBuilder().setName('richest').setDescription('Die reichsten Mitglieder').toJSON(),
      async execute(i, ctx) {
        const cfg = await cfgFor(ctx, i.guildId);
        const rows = await prisma.$queryRaw<{ userId: string; total: number }[]>`
          SELECT "userId", ("wallet" + "bank")::int AS total FROM "EconomyAccount" WHERE "guildId" = ${i.guildId} ORDER BY total DESC LIMIT 10`;
        await reply(i, embed(COLORS.warning).setTitle('💰 Reichste Mitglieder').setDescription(rows.length ? rows.map((r, idx) => `**${idx + 1}.** <@${r.userId}> – ${fmt(r.total, cfg)}`).join('\n') : 'Noch keine Daten.'));
      },
    },
  ],
};
