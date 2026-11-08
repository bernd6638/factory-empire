# Eigene Module entwickeln

Ein Modul besteht aus drei Teilen: **Definition** (Einstellungen), **Bot-Logik** und optional einer **Dashboard-Seite**. Als Beispiel dient ein einfaches „Vorschläge“-Modul.

## 1. Definition und Einstellungen

`server/src/shared/modules.ts`: Schema anlegen und in `MODULES` eintragen.

```ts
export const suggestionsSchema = z.object({
  channelId: snowflake.nullable().default(null),
  upvoteEmoji: z.string().max(64).default('👍'),
  downvoteEmoji: z.string().max(64).default('👎'),
});

export const MODULES = {
  // …
  suggestions: {
    name: 'Vorschläge',
    description: 'Mitglieder reichen Vorschläge ein, die Community stimmt ab.',
    icon: 'Lightbulb',          // lucide-react-Icon (in Plugins.tsx dem ICONS-Objekt hinzufügen)
    category: 'Community',
    defaultEnabled: false,
    schema: suggestionsSchema,
  },
} as const;
```

Damit erledigt das System automatisch:

- Speichern pro Server in `GuildModule` mit Validierung beim Speichern über die API.
- Standardwerte für fehlende Felder.
- Einen Eintrag auf der Seite *Plugins* (Ein/Aus, Standard wiederherstellen).
- `GET/PUT /api/guilds/:id/modules/suggestions`.

## 2. Bot-Logik

`server/src/bot/modules/suggestions.ts`:

```ts
import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import type { BotModule } from '../core/types';
import { embed, success, failure } from '../utils/embeds';
import { getSendableChannel } from '../utils/discord';
import { RpcError } from '../../shared/bus';

export const suggestionsModule: BotModule = {
  id: 'suggestions',

  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('suggest')
        .setDescription('Einen Vorschlag einreichen')
        .addStringOption((o) => o.setName('text').setDescription('Dein Vorschlag').setRequired(true).setMaxLength(1000))
        .toJSON(),
      async execute(i, ctx) {
        const { config } = await ctx.config.get(i.guildId, 'suggestions');
        const channel = await getSendableChannel(i.guild, config.channelId);
        if (!channel) throw new RpcError('VALIDATION', 'Es ist kein Vorschlagskanal eingerichtet.'); // wird dem Nutzer angezeigt
        const msg = await channel.send({ embeds: [embed().setAuthor({ name: i.user.username }).setDescription(i.options.getString('text', true))] });
        await msg.react(config.upvoteEmoji);
        await msg.react(config.downvoteEmoji);
        ctx.live(i.guildId, 'suggestion.created', { userId: i.user.id });          // Live an das Dashboard
        await ctx.logs.write({ guildId: i.guildId, category: 'server', type: 'suggestion', summary: `Neuer Vorschlag von ${i.user.username}` });
        await i.reply({ embeds: [success('Vorschlag eingereicht!')], flags: MessageFlags.Ephemeral });
      },
    },
  ],

  // Discord-Events – werden nur aufgerufen, wenn das Modul auf dem Server aktiv ist
  events: {
    async messageReactionAdd(ctx, reaction, user) { /* … */ },
  },

  // Hintergrundjobs (laufen nie überlappend)
  jobs: [{ name: 'cleanup', intervalMs: 3_600_000, run: async (ctx) => { /* … */ } }],

  // Methoden für das Dashboard (über die API mit apiBus().call('suggestions.stats', …))
  rpc: {
    async 'suggestions.stats'(params, ctx) {
      return { /* … */ };
    },
  },
};
```

In `server/src/bot/index.ts` registrieren:

```ts
manager.register(/* … */, suggestionsModule);
```

### Wichtige Regeln

- **Fehler:** Einfach werfen. Der `ModuleManager` fängt jeden Fehler ab, zählt ihn für das Modul und antwortet dem Nutzer. Ein `RpcError` zeigt dem Nutzer deine Meldung, andere Fehler erzeugen eine allgemeine Meldung und werden protokolliert.
- **Berechtigungen:** Vor Discord-Aktionen `requireBotPermission(...)` bzw. `botCanManageRole(...)` / `botCanModerate(...)` aus `utils/discord.ts` verwenden.
- **Daten:** Entweder eigene Prisma-Modelle anlegen (Schema erweitern, dann `npm run db:migrate -- --name suggestions`) oder den Schlüssel-Wert-Speicher `ModuleData` (`guildId`, `moduleKey`, `key`, `value`) nutzen.
- **Moderation:** Immer über `ctx.mod.perform(...)`. Damit entstehen Fallakten, Logs, Eskalation und Prüfungen automatisch.
- **Statistik:** Hochfrequente Zähler über `ctx.stats` sammeln, nicht pro Ereignis in die Datenbank schreiben.
- **Interaktionen:** Für Buttons, Menüs und Modals `components: [{ prefix: 'suggestions', handle }]` nutzen. Die `customId` hat das Format `suggestions:aktion:argument`.

## 3. API-Endpunkte (optional)

Für eigene Daten eine Route in `server/src/api/routes/` anlegen und in `api/index.ts` beim `guild`-Router einhängen:

```ts
export const suggestionsRouter = Router({ mergeParams: true });
suggestionsRouter.get('/stats', guildAccess('VIEWER'), async (req, res) => {
  res.json(await apiBus().call('suggestions.stats', { guildId: req.guildId }));
});
// api/index.ts:  guild.use('/suggestions', suggestionsRouter);
```

`guildAccess('VIEWER' | 'MODERATOR' | 'ADMIN' | 'OWNER')` prüft Anmeldung, Bot-Präsenz und Zugriffsstufe. Ändernde Anfragen landen automatisch im Audit-Log. Eingaben immer mit `validate(zodSchema, req.body)` prüfen.

## 4. Dashboard-Seite (optional)

`web/src/pages/Suggestions.tsx`:

```tsx
export default function SuggestionsPage() {
  const m = useModuleConfig('suggestions');   // lädt, verwaltet Entwurf, speichert
  if (m.isLoading || !m.config) return <LoadingBlock />;
  return (
    <>
      <PageHeader title="Vorschläge" icon={Lightbulb} />
      <ModuleToggle name="Vorschläge" enabled={m.enabled} onChange={m.setEnabled} saving={m.saving} />
      <Card>
        <Field label="Kanal">
          <ChannelSelect value={m.config.channelId} onChange={(v) => m.update((d) => void (d.channelId = v))} />
        </Field>
      </Card>
      <SaveBar dirty={m.dirty} saving={m.saving} onSave={m.save} onReset={m.reset} />
    </>
  );
}
```

Danach die Route in `web/src/App.tsx` und den Menüeintrag in `components/layout/AppLayout.tsx` (`NAV`) ergänzen. Die Typen der Einstellungen kommen automatisch aus dem Zod-Schema.

## 5. Testen

- Reine Logik als Unit-Test in `server/test/*.test.ts` (Vitest).
- Datenbanklogik mit `INTEGRATION=1 npm test`.
- `npm run typecheck` prüft Backend und Frontend.
