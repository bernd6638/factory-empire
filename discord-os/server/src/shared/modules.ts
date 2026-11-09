import { z } from 'zod';

/**
 * Plugin-/Modul-Definitionen.
 *
 * Jedes Modul besitzt:
 *  • Metadaten (Name, Beschreibung, Icon, Kategorie)
 *  • ein Zod-Schema für seine Einstellungen inklusive Standardwerten
 *
 * Die Einstellungen werden pro Server in der Tabelle `GuildModule` (JSON) gespeichert und beim Laden
 * immer durch das Schema validiert – neue Felder erhalten so automatisch ihre Standardwerte.
 */

export const snowflake = z.string().regex(/^\d{15,22}$/, 'Ungültige Discord-ID');
const optId = snowflake.nullable().default(null);
const ids = z.array(snowflake).max(100).default(() => []);
const text = (max: number, def: string) => z.string().max(max).default(def);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Farbe im Format #RRGGBB').default('#6366f1');

export const autoActionSchema = z
  .object({
    type: z.enum(['delete', 'warn', 'timeout', 'kick', 'ban']).default('delete'),
    /** Auslösende Nachricht zusätzlich löschen */
    deleteMessage: z.boolean().default(true),
    /** Nur für Timeout */
    durationMinutes: z.number().int().min(1).max(40320).default(10),
  })
  .prefault({});
export type AutoAction = z.infer<typeof autoActionSchema>;

// ─────────────── Moderation ───────────────
export const moderationSchema = z.object({
  dmOnAction: z.boolean().default(true),
  requireReason: z.boolean().default(false),
  logChannelId: optId,
  protectedRoleIds: ids,
  warnExpiryDays: z.number().int().min(0).max(3650).default(0),
  escalation: z
    .array(
      z.object({
        warnings: z.number().int().min(1).max(100),
        action: z.enum(['timeout', 'kick', 'ban']),
        durationMinutes: z.number().int().min(1).max(40320).default(60),
      }),
    )
    .max(10)
    .default(() => [
      { warnings: 3, action: 'timeout' as const, durationMinutes: 60 },
      { warnings: 5, action: 'kick' as const, durationMinutes: 60 },
    ]),
});

// ─────────────── Auto-Moderation ───────────────
export const automodSchema = z.object({
  ignoredChannelIds: ids,
  ignoredRoleIds: ids,
  logChannelId: optId,
  spam: z
    .object({
      enabled: z.boolean().default(true),
      maxMessages: z.number().int().min(2).max(50).default(6),
      intervalSeconds: z.number().int().min(1).max(120).default(5),
      duplicateThreshold: z.number().int().min(2).max(20).default(4),
      maxMentions: z.number().int().min(1).max(50).default(6),
      action: autoActionSchema,
    })
    .prefault({}),
  links: z
    .object({
      enabled: z.boolean().default(false),
      allowedDomains: z.array(z.string().max(253)).max(200).default(() => ['youtube.com', 'youtu.be', 'discord.com']),
      action: autoActionSchema,
    })
    .prefault({}),
  invites: z
    .object({
      enabled: z.boolean().default(true),
      allowOwnInvites: z.boolean().default(true),
      action: autoActionSchema,
    })
    .prefault({}),
  badwords: z
    .object({
      enabled: z.boolean().default(false),
      /** Wörter; "*" ist Platzhalter (z. B. "idiot*") */
      words: z.array(z.string().min(1).max(100)).max(500).default(() => []),
      /** Reguläre Ausdrücke (ohne Slashes) */
      regex: z.array(z.string().min(1).max(300)).max(50).default(() => []),
      action: autoActionSchema,
    })
    .prefault({}),
  caps: z
    .object({
      enabled: z.boolean().default(false),
      minLength: z.number().int().min(5).max(500).default(15),
      percent: z.number().int().min(50).max(100).default(75),
      action: autoActionSchema,
    })
    .prefault({}),
  raid: z
    .object({
      enabled: z.boolean().default(true),
      joinThreshold: z.number().int().min(3).max(200).default(10),
      intervalSeconds: z.number().int().min(5).max(600).default(15),
      action: z.enum(['alert', 'timeout', 'kick', 'ban']).default('alert'),
      /** Konten jünger als X Tage gelten als verdächtig (0 = aus) */
      minAccountAgeDays: z.number().int().min(0).max(365).default(0),
      newAccountAction: z.enum(['none', 'timeout', 'kick']).default('none'),
      alertChannelId: optId,
      lockdownMinutes: z.number().int().min(1).max(1440).default(10),
    })
    .prefault({}),
});

// ─────────────── Leveling ───────────────
export const levelCurveSchema = z
  .object({
    type: z.enum(['standard', 'linear', 'exponential']).default('standard'),
    base: z.number().int().min(10).max(100000).default(100),
    step: z.number().int().min(0).max(100000).default(50),
    growth: z.number().min(1.01).max(3).default(1.15),
  })
  .prefault({});
export type LevelCurve = z.infer<typeof levelCurveSchema>;

export const levelingSchema = z.object({
  xpMin: z.number().int().min(0).max(1000).default(15),
  xpMax: z.number().int().min(0).max(1000).default(25),
  cooldownSeconds: z.number().int().min(0).max(3600).default(60),
  curve: levelCurveSchema,
  globalMultiplier: z.number().min(0).max(10).default(1),
  roleMultipliers: z.array(z.object({ roleId: snowflake, multiplier: z.number().min(0).max(10) })).max(50).default(() => []),
  channelMultipliers: z.array(z.object({ channelId: snowflake, multiplier: z.number().min(0).max(10) })).max(50).default(() => []),
  ignoredChannelIds: ids,
  ignoredRoleIds: ids,
  voiceXp: z
    .object({
      enabled: z.boolean().default(true),
      xpPerMinute: z.number().int().min(0).max(100).default(3),
    })
    .prefault({}),
  levelUp: z
    .object({
      enabled: z.boolean().default(true),
      /** null = im Kanal der Nachricht */
      channelId: optId,
      message: text(1000, '🎉 Glückwunsch {user}, du hast **Level {level}** erreicht!'),
    })
    .prefault({}),
  rewards: z
    .array(z.object({ level: z.number().int().min(1).max(1000), roleId: snowflake.nullable().default(null), coins: z.number().int().min(0).max(1_000_000).default(0) }))
    .max(100)
    .default(() => []),
  /** true = alle Belohnungsrollen behalten, false = nur die höchste */
  stackRewards: z.boolean().default(true),
});

// ─────────────── Tickets ───────────────
export const ticketCategorySchema = z.object({
  key: z.string().regex(/^[a-z0-9-]{1,32}$/, 'Nur a-z, 0-9 und -'),
  label: z.string().min(1).max(80),
  emoji: z.string().max(64).default(''),
  description: z.string().max(100).default(''),
  supportRoleIds: ids,
  welcomeMessage: z.string().max(2000).default(''),
});
export type TicketCategory = z.infer<typeof ticketCategorySchema>;

export const ticketsSchema = z.object({
  categoryChannelId: optId,
  archiveCategoryId: optId,
  transcriptChannelId: optId,
  supportRoleIds: ids,
  maxOpenPerUser: z.number().int().min(1).max(10).default(1),
  namePattern: text(90, 'ticket-{number}'),
  closeAction: z.enum(['delete', 'archive']).default('delete'),
  pingSupport: z.boolean().default(true),
  defaultWelcome: text(2000, 'Hallo {user}! Danke für dein Ticket. Beschreibe bitte dein Anliegen – das Team meldet sich gleich.'),
  panel: z
    .object({
      channelId: optId,
      messageId: optId,
      title: text(256, '🎫 Support'),
      description: text(2000, 'Wähle unten eine Kategorie, um ein Ticket zu eröffnen.'),
      color,
    })
    .prefault({}),
  categories: z
    .array(ticketCategorySchema)
    .min(1)
    .max(10)
    .default(() => [
      { key: 'support', label: 'Support', emoji: '🛠️', description: 'Allgemeine Hilfe', supportRoleIds: [], welcomeMessage: '' },
      { key: 'report', label: 'Meldung', emoji: '🚨', description: 'Einen Nutzer melden', supportRoleIds: [], welcomeMessage: '' },
    ]),
});

// ─────────────── Economy ───────────────
export const economySchema = z.object({
  currencyName: text(32, 'Coins'),
  currencySymbol: text(16, '🪙'),
  startingBalance: z.number().int().min(0).max(1_000_000).default(100),
  daily: z
    .object({
      amount: z.number().int().min(0).max(1_000_000).default(250),
      streakBonus: z.number().int().min(0).max(100_000).default(25),
      maxStreak: z.number().int().min(1).max(365).default(7),
    })
    .prefault({}),
  work: z
    .object({
      cooldownMinutes: z.number().int().min(1).max(1440).default(60),
      min: z.number().int().min(0).max(1_000_000).default(50),
      max: z.number().int().min(0).max(1_000_000).default(150),
    })
    .prefault({}),
  messageReward: z
    .object({
      enabled: z.boolean().default(false),
      min: z.number().int().min(0).max(10_000).default(1),
      max: z.number().int().min(0).max(10_000).default(5),
      cooldownSeconds: z.number().int().min(0).max(3600).default(60),
    })
    .prefault({}),
  transferTaxPercent: z.number().int().min(0).max(50).default(0),
  companyCreateCost: z.number().int().min(0).max(10_000_000).default(5000),
  companyBonusPercent: z.number().int().min(0).max(100).default(10),
  maxCompanyMembers: z.number().int().min(1).max(100).default(10),
});

// ─────────────── Automatisierung ───────────────
export const automationSchema = z.object({
  timezone: text(64, 'Europe/Berlin'),
  /** Maximale Ausführungen pro Regel und Minute (Schutz vor Endlosschleifen) */
  maxRunsPerMinute: z.number().int().min(1).max(120).default(30),
});

// ─────────────── Willkommen ───────────────
export const welcomeSchema = z.object({
  welcome: z
    .object({
      enabled: z.boolean().default(false),
      channelId: optId,
      message: text(2000, 'Willkommen auf **{server}**, {user}! Du bist Mitglied Nr. {memberCount}.'),
      embed: z.boolean().default(true),
      color,
    })
    .prefault({}),
  leave: z
    .object({
      enabled: z.boolean().default(false),
      channelId: optId,
      message: text(2000, '**{username}** hat den Server verlassen.'),
    })
    .prefault({}),
  dm: z
    .object({
      enabled: z.boolean().default(false),
      message: text(2000, 'Willkommen auf {server}! Bitte lies dir die Regeln durch.'),
    })
    .prefault({}),
  autoroles: z
    .object({
      humans: ids,
      bots: ids,
      delaySeconds: z.number().int().min(0).max(3600).default(0),
    })
    .prefault({}),
});

// ─────────────── Voice-Manager ───────────────
export const voiceSchema = z.object({
  creatorChannelIds: ids,
  /** null = Kategorie des Erstellen-Kanals */
  categoryId: optId,
  nameTemplate: text(100, '🔊 {user}s Kanal'),
  defaultLimit: z.number().int().min(0).max(99).default(0),
  allowRename: z.boolean().default(true),
  allowLimit: z.boolean().default(true),
  allowLock: z.boolean().default(true),
  deleteDelaySeconds: z.number().int().min(0).max(3600).default(0),
});

// ─────────────── Logging ───────────────
export const LOG_CATEGORIES = ['messages', 'members', 'roles', 'channels', 'moderation', 'voice', 'server'] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

export const loggingSchema = z.object({
  channels: z
    .object({
      messages: optId,
      members: optId,
      roles: optId,
      channels: optId,
      moderation: optId,
      voice: optId,
      server: optId,
    })
    .prefault({}),
  events: z
    .object({
      messageDelete: z.boolean().default(true),
      messageUpdate: z.boolean().default(true),
      memberJoin: z.boolean().default(true),
      memberLeave: z.boolean().default(true),
      memberUpdate: z.boolean().default(true),
      roleChanges: z.boolean().default(true),
      channelChanges: z.boolean().default(true),
      moderation: z.boolean().default(true),
      voice: z.boolean().default(true),
    })
    .prefault({}),
  ignoredChannelIds: ids,
  ignoreBots: z.boolean().default(true),
  retentionDays: z.number().int().min(1).max(365).default(90),
});

// ─────────────── Giveaways ───────────────
export const giveawaysSchema = z.object({
  buttonLabel: text(40, 'Teilnehmen'),
  buttonEmoji: text(32, '🎉'),
  dmWinners: z.boolean().default(true),
  pingRoleId: optId,
  announceTemplate: text(1000, '🎉 Glückwunsch {winners}! Ihr habt **{prize}** gewonnen.'),
  reminderTemplate: text(500, '⏰ Nur noch {time} – letzte Chance für **{prize}**!'),
});

// ─────────────── KI-Sprach-Bot (lokal) ───────────────
export const voiceaiSchema = z.object({
  botName: text(32, 'Rad'),
  /** Zusätzliche Aktivierungswörter; der Bot-Name zählt immer */
  wakeWords: z.array(z.string().min(2).max(40)).max(10).default(() => []),
  requireWakeWord: z.boolean().default(true),
  /** Nach einer Antwort darf man so lange ohne Aktivierungswort weiterreden */
  followUpSeconds: z.number().int().min(0).max(120).default(20),
  persona: text(
    2000,
    'Du bist {name}, ein freundlicher, schlagfertiger Discord-Bot auf dem Server „{server}“. Du unterhältst dich locker auf Deutsch. Deine Antworten werden laut vorgelesen: antworte kurz und natürlich in 1–3 Sätzen, ohne Emojis, Listen oder Markdown.',
  ),
  model: text(80, 'qwen2.5:7b'),
  temperature: z.number().min(0).max(1.5).default(0.7),
  maxTokens: z.number().int().min(20).max(600).default(140),
  historyTurns: z.number().int().min(0).max(30).default(8),
  language: text(8, 'de'),
  voice: text(80, 'de_DE-thorsten-medium'),
  speechRate: z.number().min(0.5).max(2).default(1),
  transcriptChannelId: optId,
  allowedRoleIds: ids,
  autoLeaveMinutes: z.number().int().min(1).max(120).default(5),
  announceJoin: z.boolean().default(true),
});

// ─────────────── Registry ───────────────

export const MODULES = {
  moderation: {
    name: 'Moderation',
    description: 'Warnungen, Timeouts, Kicks, Bans, Fallakten und automatische Eskalation.',
    icon: 'Gavel',
    category: 'Sicherheit',
    defaultEnabled: true,
    schema: moderationSchema,
  },
  automod: {
    name: 'Auto-Moderation',
    description: 'Spam-, Link-, Einladungs-, Wort- und Raid-Schutz in Echtzeit.',
    icon: 'ShieldAlert',
    category: 'Sicherheit',
    defaultEnabled: true,
    schema: automodSchema,
  },
  logging: {
    name: 'Logging',
    description: 'Protokolliert Nachrichten, Mitglieder, Rollen, Kanäle, Voice und Moderation.',
    icon: 'ScrollText',
    category: 'Sicherheit',
    defaultEnabled: true,
    schema: loggingSchema,
  },
  leveling: {
    name: 'Level & XP',
    description: 'XP für Aktivität, Levelkurven, Ranglisten und Levelrollen.',
    icon: 'TrendingUp',
    category: 'Community',
    defaultEnabled: true,
    schema: levelingSchema,
  },
  welcome: {
    name: 'Willkommen',
    description: 'Begrüßungs- und Abschiedsnachrichten, DMs und automatische Rollen.',
    icon: 'HandHeart',
    category: 'Community',
    defaultEnabled: false,
    schema: welcomeSchema,
  },
  tickets: {
    name: 'Tickets',
    description: 'Support-Tickets mit Kategorien, Prioritäten, Zuweisung und Transkripten.',
    icon: 'Ticket',
    category: 'Support',
    defaultEnabled: false,
    schema: ticketsSchema,
  },
  economy: {
    name: 'Economy',
    description: 'Virtuelle Währung, Shop, Inventar, Handel, Jobs und Firmen (kein Echtgeld).',
    icon: 'Coins',
    category: 'Community',
    defaultEnabled: false,
    schema: economySchema,
  },
  automation: {
    name: 'Automatisierungen',
    description: 'Regeln mit Auslösern und Aktionen, Zeitpläne und Inaktivitätserkennung.',
    icon: 'Workflow',
    category: 'Werkzeuge',
    defaultEnabled: true,
    schema: automationSchema,
  },
  giveaways: {
    name: 'Giveaways',
    description: 'Gewinnspiele mit Teilnahmebedingungen, fairer Ziehung, Ersatzgewinnern und Statistiken.',
    icon: 'Gift',
    category: 'Community',
    defaultEnabled: true,
    schema: giveawaysSchema,
  },
  voiceai: {
    name: 'KI-Sprach-Bot',
    description: 'Der Bot kommt in den Sprachkanal und unterhält sich mit euch – komplett lokal (Whisper, Ollama, Piper).',
    icon: 'AudioLines',
    category: 'Werkzeuge',
    defaultEnabled: false,
    schema: voiceaiSchema,
  },
  voice: {
    name: 'Voice-Manager',
    description: 'Temporäre Sprachkanäle per Join-to-Create mit Besitzerrechten.',
    icon: 'Mic',
    category: 'Werkzeuge',
    defaultEnabled: false,
    schema: voiceSchema,
  },
} as const;

export type ModuleKey = keyof typeof MODULES;
export const MODULE_KEYS = Object.keys(MODULES) as ModuleKey[];

export type ModuleConfigs = { [K in ModuleKey]: z.infer<(typeof MODULES)[K]['schema']> };
export type ModuleConfig<K extends ModuleKey> = ModuleConfigs[K];

export function isModuleKey(v: string): v is ModuleKey {
  return Object.prototype.hasOwnProperty.call(MODULES, v);
}

/** Validiert gespeicherte Konfiguration; ungültige Werte fallen auf Standardwerte zurück. */
export function parseModuleConfig<K extends ModuleKey>(key: K, raw: unknown): ModuleConfig<K> {
  const schema = MODULES[key].schema as unknown as z.ZodType<ModuleConfig<K>>;
  const res = schema.safeParse(raw ?? {});
  if (res.success) return res.data;
  // Fehlerhafte Felder verwerfen statt das Modul lahmzulegen
  const cleaned = typeof raw === 'object' && raw !== null ? { ...(raw as Record<string, unknown>) } : {};
  for (const issue of res.error.issues) {
    const top = issue.path[0];
    if (typeof top === 'string') delete (cleaned as Record<string, unknown>)[top];
  }
  const second = schema.safeParse(cleaned);
  return second.success ? second.data : schema.parse({});
}

export function defaultModuleConfig<K extends ModuleKey>(key: K): ModuleConfig<K> {
  return parseModuleConfig(key, {});
}
