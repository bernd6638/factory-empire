import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { snowflake } from './modules';

/** Auslöser für Automatisierungsregeln. */
export const TRIGGERS = {
  MEMBER_JOIN: 'Mitglied tritt bei',
  MEMBER_LEAVE: 'Mitglied verlässt den Server',
  MESSAGE_CONTAINS: 'Nachricht enthält Text',
  REACTION_ADD: 'Reaktion hinzugefügt',
  ROLE_ADDED: 'Rolle erhalten',
  LEVEL_UP: 'Level erreicht',
  SCHEDULE: 'Zeitplan (Cron)',
  INACTIVITY: 'Mitglied inaktiv',
} as const;
export type TriggerType = keyof typeof TRIGGERS;

export const triggerConfigSchemas = {
  MEMBER_JOIN: z.object({}),
  MEMBER_LEAVE: z.object({}),
  MESSAGE_CONTAINS: z.object({
    keywords: z.array(z.string().min(1).max(200)).min(1).max(50),
    matchMode: z.enum(['contains', 'exact', 'startsWith', 'regex']).default('contains'),
    caseSensitive: z.boolean().default(false),
    channelIds: z.array(snowflake).max(50).default(() => []),
  }),
  REACTION_ADD: z.object({
    messageId: snowflake.nullable().default(null),
    emoji: z.string().max(64).default(''),
  }),
  ROLE_ADDED: z.object({ roleId: snowflake }),
  LEVEL_UP: z.object({ level: z.number().int().min(1).max(1000).nullable().default(null) }),
  SCHEDULE: z.object({ cron: z.string().min(9).max(100) }),
  INACTIVITY: z.object({ days: z.number().int().min(1).max(365) }),
} satisfies Record<TriggerType, z.ZodType>;

export const conditionsSchema = z
  .object({
    ignoreBots: z.boolean().default(true),
    requiredRoleIds: z.array(snowflake).max(25).default(() => []),
    excludedRoleIds: z.array(snowflake).max(25).default(() => []),
  })
  .prefault({});

const delay = z.number().int().min(0).max(900).default(0);

export const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('SEND_MESSAGE'),
    /** null = Kanal des Ereignisses */
    channelId: snowflake.nullable().default(null),
    content: z.string().min(1).max(2000),
    embed: z.boolean().default(false),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1'),
    delaySeconds: delay,
  }),
  z.object({ type: z.literal('REPLY'), content: z.string().min(1).max(2000), delaySeconds: delay }),
  z.object({ type: z.literal('SEND_DM'), content: z.string().min(1).max(2000), delaySeconds: delay }),
  z.object({ type: z.literal('ADD_ROLE'), roleId: snowflake, delaySeconds: delay }),
  z.object({ type: z.literal('REMOVE_ROLE'), roleId: snowflake, delaySeconds: delay }),
  z.object({ type: z.literal('ADD_REACTION'), emoji: z.string().min(1).max(64), delaySeconds: delay }),
  z.object({ type: z.literal('DELETE_MESSAGE'), delaySeconds: delay }),
  z.object({ type: z.literal('TIMEOUT'), minutes: z.number().int().min(1).max(40320), reason: z.string().max(400).default('Automatisierung'), delaySeconds: delay }),
]);
export type AutomationAction = z.infer<typeof actionSchema>;

export const ACTION_LABELS: Record<AutomationAction['type'], string> = {
  SEND_MESSAGE: 'Nachricht senden',
  REPLY: 'Antworten',
  SEND_DM: 'Direktnachricht senden',
  ADD_ROLE: 'Rolle hinzufügen',
  REMOVE_ROLE: 'Rolle entfernen',
  ADD_REACTION: 'Reaktion hinzufügen',
  DELETE_MESSAGE: 'Nachricht löschen',
  TIMEOUT: 'Timeout',
};

export const automationInputSchema = z
  .object({
    name: z.string().min(1).max(100),
    enabled: z.boolean().default(true),
    trigger: z.enum(Object.keys(TRIGGERS) as [TriggerType, ...TriggerType[]]),
    triggerConfig: z.record(z.string(), z.unknown()).default(() => ({})),
    conditions: conditionsSchema,
    actions: z.array(actionSchema).min(1).max(10),
  })
  .superRefine((val, ctx) => {
    const res = triggerConfigSchemas[val.trigger].safeParse(val.triggerConfig);
    if (!res.success) {
      for (const issue of res.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: ['triggerConfig', ...issue.path.map(String)] });
    }
    if (val.trigger === 'MESSAGE_CONTAINS' && res.success) {
      const cfg = res.data as z.infer<(typeof triggerConfigSchemas)['MESSAGE_CONTAINS']>;
      if (cfg.matchMode === 'regex') {
        for (const k of cfg.keywords) {
          try {
            new RegExp(k);
          } catch {
            ctx.addIssue({ code: 'custom', message: `Ungültiger regulärer Ausdruck: ${k}`, path: ['triggerConfig', 'keywords'] });
          }
        }
      }
    }
  });
export type AutomationInput = z.infer<typeof automationInputSchema>;

/** Ob eine Nachricht auf eine MESSAGE_CONTAINS-Regel passt. */
export function matchesMessage(content: string, cfg: z.infer<(typeof triggerConfigSchemas)['MESSAGE_CONTAINS']>): boolean {
  const text = cfg.caseSensitive ? content : content.toLowerCase();
  return cfg.keywords.some((raw) => {
    const k = cfg.caseSensitive ? raw : raw.toLowerCase();
    switch (cfg.matchMode) {
      case 'exact':
        return text.trim() === k.trim();
      case 'startsWith':
        return text.startsWith(k);
      case 'regex':
        try {
          return new RegExp(raw, cfg.caseSensitive ? '' : 'i').test(content);
        } catch {
          return false;
        }
      default:
        return text.includes(k);
    }
  });
}

/** Nächster Ausführungszeitpunkt eines Cron-Ausdrucks (oder null bei ungültigem Ausdruck). */
export function nextCronRun(expr: string, timezone: string, from = new Date()): Date | null {
  try {
    return CronExpressionParser.parse(expr, { tz: timezone, currentDate: from }).next().toDate();
  } catch {
    return null;
  }
}
