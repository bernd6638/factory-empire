import { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import prism from 'prism-media';
import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type Guild, type VoiceBasedChannel } from 'discord.js';
import { z } from 'zod';
import { env } from '../../shared/env';
import { redis } from '../../shared/redis';
import { RpcError } from '../../shared/bus';
import { renderTemplate } from '../../shared/template';
import { childLogger } from '../../shared/logger';
import { snowflake, type ModuleConfig } from '../../shared/modules';
import type { BotContext, BotModule } from '../core/types';
import { embed, COLORS, success, truncate } from '../utils/embeds';
import { getSendableChannel } from '../utils/discord';
import { cleanForSpeech, detectWakeWord, discordToWhisper, rms, toDiscord, toMono, wavDecode, wavEncode } from '../utils/audio';
import { getGuild, parse } from './core';

/**
 * KI-Sprach-Bot: hört im Sprachkanal zu, versteht Sprache (Whisper), antwortet mit einem lokalen
 * Sprachmodell (Ollama) und spricht die Antwort (Piper). Alles läuft lokal – Audio wird nicht gespeichert.
 *
 * Ablauf pro Äußerung: Opus → PCM 48 kHz → 16 kHz Mono → /stt → Aktivierungswort prüfen →
 * Ollama /api/chat (mit Gesprächsverlauf) → /tts → 48 kHz Stereo → Wiedergabe.
 */

const log = childLogger('voiceai');
type Cfg = ModuleConfig<'voiceai'>;

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

interface Session {
  guildId: string;
  channelId: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  history: Turn[];
  capturing: Set<string>;
  followUp: Map<string, number>;
  queue: { userId: string; name: string; text: string }[];
  busy: boolean;
  lastHuman: number;
  turns: number;
  startedAt: number;
}

const sessions = new Map<string, Session>();

// ─── Lokale KI-Dienste ───

async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 60_000) });
  if (!res.ok) throw new Error(`${new URL(url).pathname} antwortet mit ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function transcribe(wav: Buffer, language: string): Promise<string> {
  const r = await fetchJson<{ text: string }>(`${env().VOICE_AI_URL}/stt?language=${encodeURIComponent(language)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: new Uint8Array(wav),
    timeoutMs: 30_000,
  });
  return r.text.trim();
}

async function synthesize(text: string, voice: string, rate: number): Promise<Buffer> {
  const res = await fetch(`${env().VOICE_AI_URL}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, length_scale: 1 / rate }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Sprachausgabe fehlgeschlagen (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function chat(cfg: Cfg, guildName: string, history: Turn[], userLine: string): Promise<string> {
  const system = renderTemplate(cfg.persona, { name: cfg.botName, server: guildName });
  const r = await fetchJson<{ message?: { content: string } }>(`${env().OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      keep_alive: '30m',
      messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: userLine }],
      options: { temperature: cfg.temperature, num_predict: cfg.maxTokens },
    }),
    timeoutMs: 90_000,
  });
  return r.message?.content?.trim() ?? '';
}

/**
 * Antwort als Stream: liefert fertige Sätze, sobald das Modell sie geschrieben hat.
 * So kann der erste Satz schon gesprochen werden, während der Rest noch entsteht.
 */
export async function* chatSentences(cfg: Cfg, guildName: string, history: Turn[], userLine: string): AsyncGenerator<string> {
  const system = renderTemplate(cfg.persona, { name: cfg.botName, server: guildName });
  const res = await fetch(`${env().OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      stream: true,
      keep_alive: '60m',
      messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: userLine }],
      options: { temperature: cfg.temperature, num_predict: cfg.maxTokens },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama antwortet mit ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let lineBuf = '';
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    lineBuf += dec.decode(value, { stream: true });
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const j = JSON.parse(line) as { message?: { content?: string }; error?: string };
      if (j.error) throw new Error(j.error);
      text += j.message?.content ?? '';
      const { sentences, rest } = splitSentences(text);
      text = rest;
      for (const sentence of sentences) yield sentence;
    }
  }
  if (text.trim()) yield text.trim();
}

/** Trennt fertige Sätze ab (mindestens ~20 Zeichen, damit sehr kurze Stücke nicht abgehackt klingen). */
export function splitSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = text;
  for (;;) {
    const m = rest.match(/^([\s\S]{20,}?[.!?…])(\s+)/);
    if (!m) break;
    sentences.push(m[1]!.trim());
    rest = rest.slice(m[0].length);
  }
  return { sentences, rest };
}

/** Lädt das Modell vorab in die Grafikkarte, damit die erste Antwort nicht lange dauert. */
async function warmup(cfg: Cfg) {
  await fetch(`${env().OLLAMA_URL}/api/generate`, {
    method: 'POST',
    body: JSON.stringify({ model: cfg.model, prompt: '', keep_alive: '60m' }),
    signal: AbortSignal.timeout(120_000),
  }).catch((err) => log.debug({ err: err?.message }, 'Vorladen des Modells fehlgeschlagen'));
}

// ─── Sitzung ───

function wakeWords(cfg: Cfg) {
  return [cfg.botName, `hey ${cfg.botName}`, `hallo ${cfg.botName}`, ...cfg.wakeWords];
}

async function speak(s: Session, text: string, cfg: Cfg) {
  await play(s, await synthesize(text, cfg.voice, cfg.speechRate));
}

async function play(s: Session, wav: Buffer) {
  const w = wavDecode(wav);
  const pcm = toDiscord(toMono(w.pcm, w.channels), w.sampleRate);
  const resource = createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw });
  s.player.play(resource);
  await entersState(s.player, AudioPlayerStatus.Playing, 5_000).catch(() => undefined);
  await entersState(s.player, AudioPlayerStatus.Idle, 120_000).catch(() => undefined);
}

async function processQueue(ctx: BotContext, s: Session) {
  if (s.busy) return;
  s.busy = true;
  try {
    while (s.queue.length) {
      const item = s.queue.shift()!;
      const guild = ctx.client.guilds.cache.get(s.guildId);
      if (!guild) break;
      const { config: cfg } = await ctx.config.get(s.guildId, 'voiceai');
      const t0 = Date.now();
      const stage = (stage: 'thinking' | 'speaking' | 'done' | 'error', message?: string) => ctx.live(s.guildId, 'voiceai.stage', { stage, message, userId: item.userId, name: item.name, at: Date.now() });
      stage('thinking');
      const parts: string[] = [];
      let firstMs = 0;
      // Wiedergabe-Kette: jeder Satz wird sofort synthetisiert und der Reihe nach abgespielt
      let chain: Promise<void> = Promise.resolve();
      let ttsError: string | null = null;
      const enqueue = (sentence: string) => {
        const clean = cleanForSpeech(sentence);
        if (!clean) return;
        parts.push(clean);
        const audio = synthesize(clean, cfg.voice, cfg.speechRate).catch((err) => {
          ttsError = String(err?.message ?? err);
          return null;
        });
        chain = chain.then(async () => {
          const wav = await audio;
          if (!wav) return;
          if (parts.length === 1 || !firstMs) {
            firstMs = firstMs || Date.now() - t0;
            stage('speaking');
          }
          await play(s, wav).catch((err) => (ttsError = String(err?.message ?? err)));
        });
      };
      try {
        for await (const sentence of chatSentences(cfg, guild.name, s.history, `${item.name}: ${item.text}`)) enqueue(sentence);
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        log.warn({ err: msg, model: cfg.model }, 'Sprachmodell-Anfrage fehlgeschlagen');
        stage('error', `Sprachmodell (${cfg.model}): ${msg}`);
        if (!parts.length) enqueue('Mein Sprachmodell ist gerade nicht erreichbar.');
      }
      if (!parts.length) {
        stage('error', `Das Sprachmodell (${cfg.model}) hat eine leere Antwort geliefert.`);
        continue;
      }
      const answer = parts.join(' ');
      const tLlm = Date.now() - t0;
      s.history.push({ role: 'user', content: `${item.name}: ${item.text}` }, { role: 'assistant', content: answer });
      if (s.history.length > cfg.historyTurns * 2) s.history.splice(0, s.history.length - cfg.historyTurns * 2);
      s.turns++;
      s.followUp.set(item.userId, Date.now());
      ctx.live(s.guildId, 'voiceai.turn', { userId: item.userId, name: item.name, text: item.text, answer, llmMs: tLlm, firstAudioMs: firstMs, at: Date.now() });

      await Promise.race([chain, new Promise((r) => setTimeout(r, 120_000))]);
      if (ttsError) {
        log.warn({ err: ttsError, voice: cfg.voice }, 'Sprachausgabe fehlgeschlagen');
        stage('error', `Sprachausgabe (${cfg.voice}): ${ttsError}`);
      }
      log.info({ guild: s.guildId, firstAudioMs: firstMs, totalMs: Date.now() - t0 }, 'Sprach-Bot: Antwort gesprochen');
      s.followUp.set(item.userId, Date.now()); // Nachfrage-Fenster ab Ende der Antwort
      stage('done');

      if (cfg.transcriptChannelId) {
        const ch = await getSendableChannel(guild, cfg.transcriptChannelId);
        await ch?.send({ content: `🗣️ **${item.name}:** ${truncate(item.text, 900)}\n🤖 **${cfg.botName}:** ${truncate(answer, 900)}`, allowedMentions: { parse: [] } }).catch(() => undefined);
      }
    }
  } finally {
    s.busy = false;
  }
}

async function handleUtterance(ctx: BotContext, s: Session, userId: string, pcm48: Buffer) {
  const guild = ctx.client.guilds.cache.get(s.guildId);
  if (!guild) return;
  const { config: cfg } = await ctx.config.get(s.guildId, 'voiceai');
  const pcm16 = discordToWhisper(pcm48);
  const seconds = pcm16.length / 2 / 16000;
  if (seconds < 0.5 || rms(pcm16) < 0.004) return; // zu kurz oder nur Rauschen

  let text: string;
  try {
    text = await transcribe(wavEncode(pcm16, 16000, 1), cfg.language);
  } catch (err: any) {
    log.warn({ err: err?.message }, 'Spracherkennung nicht erreichbar');
    ctx.live(s.guildId, 'voiceai.stage', { stage: 'error', message: `Spracherkennung: ${String(err?.message ?? err)}`, userId, at: Date.now() });
    return;
  }
  if (!text || text.length < 2) return;
  const member = guild.members.cache.get(userId);
  const name = member?.displayName ?? 'Jemand';

  const wake = detectWakeWord(text, wakeWords(cfg));
  const inFollowUp = Date.now() - (s.followUp.get(userId) ?? 0) < cfg.followUpSeconds * 1000;
  ctx.live(s.guildId, 'voiceai.heard', { userId, name, text, triggered: !cfg.requireWakeWord || wake.hit || inFollowUp, at: Date.now() });
  if (cfg.requireWakeWord && !wake.hit && !inFollowUp) return;

  const content = wake.hit ? wake.rest || 'Ja?' : text;
  // Nicht mehr als 3 Fragen stapeln – sonst antwortet der Bot noch Minuten später
  s.followUp.set(userId, Date.now());
  if (s.queue.length < 3) s.queue.push({ userId, name, text: content });
  void processQueue(ctx, s);
}

function listen(ctx: BotContext, s: Session) {
  const receiver = s.connection.receiver;
  receiver.speaking.on('start', async (userId) => {
    if (s.capturing.has(userId)) return;
    const guild = ctx.client.guilds.cache.get(s.guildId);
    const member = guild?.members.cache.get(userId);
    if (!member || member.user.bot) return;
    const { config: cfg } = await ctx.config.get(s.guildId, 'voiceai');
    if (cfg.allowedRoleIds.length && !member.roles.cache.some((r) => cfg.allowedRoleIds.includes(r.id))) return;
    // Während der Bot spricht, nicht zuhören (verhindert, dass er sich selbst unterbricht)
    if (s.player.state.status === AudioPlayerStatus.Playing) return;

    s.capturing.add(userId);
    s.lastHuman = Date.now();
    const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 700 } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const maxBytes = 48000 * 4 * 30; // höchstens 30 Sekunden pro Äußerung
    opus.pipe(decoder);
    decoder.on('data', (c: Buffer) => {
      if (bytes < maxBytes) {
        chunks.push(c);
        bytes += c.length;
      } else opus.destroy();
    });
    const finish = () => {
      if (!s.capturing.delete(userId)) return;
      void handleUtterance(ctx, s, userId, Buffer.concat(chunks)).catch((err) => log.warn({ err: err?.message }, 'Äußerung konnte nicht verarbeitet werden'));
    };
    decoder.once('end', finish);
    opus.once('error', finish);
    decoder.once('error', finish);
  });
}

export async function joinTalk(ctx: BotContext, channel: VoiceBasedChannel): Promise<Session> {
  const guild = channel.guild;
  const me = guild.members.me!;
  if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) throw new RpcError('MISSING_PERMISSIONS', 'Der Bot darf diesem Sprachkanal nicht beitreten oder dort nicht sprechen.');
  const existing = sessions.get(guild.id);
  if (existing && existing.channelId === channel.id) return existing;
  if (existing) leaveTalk(ctx, guild.id, 'Kanalwechsel');

  const connection = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    connection.destroy();
    throw new RpcError('DISCORD_ERROR', 'Verbindung zum Sprachkanal fehlgeschlagen.');
  }
  const player = createAudioPlayer();
  connection.subscribe(player);
  const s: Session = { guildId: guild.id, channelId: channel.id, connection, player, history: [], capturing: new Set(), followUp: new Map(), queue: [], busy: false, lastHuman: Date.now(), turns: 0, startedAt: Date.now() };
  sessions.set(guild.id, s);
  let reconnects = 0;
  connection.on('stateChange', (oldS, newS) => {
    if (oldS.status !== newS.status) log.info({ guild: guild.id, from: oldS.status, to: newS.status }, 'Sprachverbindung');
    if (newS.status === VoiceConnectionStatus.Ready) reconnects = 0;
  });
  connection.on('error', (err) => log.warn({ err: err.message }, 'Fehler der Sprachverbindung'));
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Kurze Unterbrechung (z. B. Kanalwechsel, Discord-Serverwechsel): Discord verbindet selbst neu
      await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5_000), entersState(connection, VoiceConnectionStatus.Connecting, 5_000)]);
    } catch {
      // Sonst bis zu 5-mal selbst neu verbinden, bevor aufgegeben wird
      if (reconnects < 5 && sessions.get(guild.id)?.connection === connection) {
        reconnects++;
        log.warn({ guild: guild.id, attempt: reconnects }, 'Sprachverbindung getrennt – verbinde neu');
        await new Promise((r) => setTimeout(r, reconnects * 2000));
        connection.rejoin();
      } else leaveTalk(ctx, guild.id, 'Verbindung getrennt');
    }
  });
  listen(ctx, s);

  const { config: cfg } = await ctx.config.get(guild.id, 'voiceai');
  void warmup(cfg);
  if (cfg.announceJoin && channel.isTextBased()) {
    await channel
      .send({ embeds: [embed(COLORS.violet).setDescription(`🎙️ **${cfg.botName}** hört jetzt in diesem Sprachkanal zu.\nSprich mich mit „${cfg.botName}, …“ an. Audio wird nur zur Erkennung verarbeitet und **nicht gespeichert**.`)] })
      .catch(() => undefined);
  }
  ctx.live(guild.id, 'voiceai.session', { connected: true, channelId: channel.id });
  return s;
}

export function leaveTalk(ctx: BotContext, guildId: string, reason = 'Beendet') {
  const s = sessions.get(guildId);
  if (!s) return false;
  sessions.delete(guildId);
  s.player.stop(true);
  s.connection.destroy();
  ctx.live(guildId, 'voiceai.session', { connected: false, reason });
  return true;
}

function status(s: Session | undefined, guild: Guild) {
  if (!s) return { connected: false };
  const ch = guild.channels.cache.get(s.channelId) as VoiceBasedChannel | undefined;
  return {
    connected: true,
    channelId: s.channelId,
    channelName: ch?.name ?? null,
    listeners: ch ? ch.members.filter((m) => !m.user.bot).map((m) => ({ id: m.id, name: m.displayName, avatar: m.displayAvatarURL({ size: 64 }) })) : [],
    turns: s.turns,
    startedAt: s.startedAt,
    busy: s.busy,
  };
}

const PULL_KEY = 'dos:voiceai:pull';

export const voiceaiModule: BotModule = {
  id: 'voiceai',

  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('talk')
        .setDescription('KI-Sprach-Bot im Sprachkanal')
        .addSubcommand((s) => s.setName('join').setDescription('Bot kommt in deinen Sprachkanal'))
        .addSubcommand((s) => s.setName('leave').setDescription('Bot verlässt den Sprachkanal'))
        .addSubcommand((s) => s.setName('reset').setDescription('Gesprächsverlauf vergessen'))
        .toJSON(),
      async execute(i, ctx) {
        const sub = i.options.getSubcommand();
        if (sub === 'join') {
          const channel = i.member.voice.channel;
          if (!channel) throw new RpcError('VALIDATION', 'Geh zuerst in einen Sprachkanal.');
          await i.deferReply({ flags: MessageFlags.Ephemeral });
          await joinTalk(ctx, channel);
          const { config } = await ctx.config.get(i.guildId, 'voiceai');
          await i.editReply({ embeds: [success(`Ich bin in **${channel.name}**. Sprich mich mit „${config.botName}, …“ an.`)] });
        } else if (sub === 'leave') {
          const ok = leaveTalk(ctx, i.guildId);
          await i.reply({ embeds: [success(ok ? 'Ich habe den Sprachkanal verlassen.' : 'Ich bin in keinem Sprachkanal.')], flags: MessageFlags.Ephemeral });
        } else {
          const s = sessions.get(i.guildId);
          if (s) s.history = [];
          await i.reply({ embeds: [success('Gesprächsverlauf gelöscht.')], flags: MessageFlags.Ephemeral });
        }
      },
    },
  ],

  events: {
    // Wenn niemand mehr im Kanal ist, nach der eingestellten Zeit gehen
    async voiceStateUpdate(ctx, oldState) {
      const s = sessions.get(oldState.guild.id);
      if (!s || oldState.channelId !== s.channelId) return;
      const ch = oldState.guild.channels.cache.get(s.channelId) as VoiceBasedChannel | undefined;
      if (ch && ch.members.filter((m) => !m.user.bot).size === 0) s.lastHuman = Date.now();
    },
  },

  jobs: [
    {
      name: 'voiceai-autoleave',
      intervalMs: 30_000,
      async run(ctx) {
        for (const s of sessions.values()) {
          const guild = ctx.client.guilds.cache.get(s.guildId);
          const ch = guild?.channels.cache.get(s.channelId) as VoiceBasedChannel | undefined;
          const humans = ch ? ch.members.filter((m) => !m.user.bot).size : 0;
          if (humans > 0) {
            s.lastHuman = Date.now();
            continue;
          }
          const { config } = await ctx.config.get(s.guildId, 'voiceai');
          if (Date.now() - s.lastHuman > config.autoLeaveMinutes * 60_000) leaveTalk(ctx, s.guildId, 'Niemand mehr im Kanal');
        }
      },
    },
  ],

  rpc: {
    async 'voiceai.status'(p, ctx) {
      const guild = getGuild(ctx, p.guildId);
      return status(sessions.get(guild.id), guild);
    },
    async 'voiceai.join'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, channelId: snowflake }), p);
      const guild = getGuild(ctx, input.guildId);
      const ch = guild.channels.cache.get(input.channelId);
      if (!ch || (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice)) throw new RpcError('NOT_FOUND', 'Sprachkanal nicht gefunden.');
      await joinTalk(ctx, ch as VoiceBasedChannel);
      return status(sessions.get(guild.id), guild);
    },
    async 'voiceai.leave'(p, ctx) {
      return { left: leaveTalk(ctx, String(p.guildId)) };
    },
    async 'voiceai.reset'(p) {
      const s = sessions.get(String(p.guildId));
      if (s) s.history = [];
      return { ok: true };
    },
    /** Prüft, ob Spracherkennung/-ausgabe und Ollama samt Modell bereit sind. */
    async 'voiceai.health'(p, ctx) {
      const { config: cfg } = await ctx.config.get(String(p.guildId), 'voiceai');
      const e = env();
      const [speech, ollama] = await Promise.all([
        fetchJson<{ ok: boolean; whisperModel: string; whisperLoaded: boolean; device: string; voices: string[] }>(`${e.VOICE_AI_URL}/health`, { timeoutMs: 4000 }).catch((err) => ({ error: String(err?.message ?? err) })),
        fetchJson<{ models: { name: string; size: number }[] }>(`${e.OLLAMA_URL}/api/tags`, { timeoutMs: 4000 }).catch((err) => ({ error: String(err?.message ?? err) })),
      ]);
      const models = 'models' in ollama ? ollama.models.map((m) => ({ name: m.name, sizeGb: Math.round((m.size / 1e9) * 10) / 10 })) : [];
      const pull = await redis().get(PULL_KEY);
      return {
        speech: 'error' in speech ? { ok: false, error: speech.error } : { ...speech, ok: true },
        ollama: 'error' in ollama ? { ok: false, error: ollama.error } : { ok: true, models },
        modelReady: models.some((m) => m.name === cfg.model || m.name === `${cfg.model}:latest`),
        model: cfg.model,
        pull: pull ? JSON.parse(pull) : null,
      };
    },
    /** Lädt ein Ollama-Modell herunter (läuft im Hintergrund, Fortschritt per Live-Event). */
    async 'voiceai.pull'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, model: z.string().min(1).max(80).regex(/^[a-zA-Z0-9._:/-]+$/) }), p);
      const running = await redis().get(PULL_KEY);
      if (running && JSON.parse(running).status === 'running') throw new RpcError('VALIDATION', 'Es wird bereits ein Modell heruntergeladen.');
      const report = async (data: Record<string, unknown>) => {
        await redis().set(PULL_KEY, JSON.stringify({ model: input.model, ...data, at: Date.now() }), 'EX', 3600);
        ctx.live(input.guildId, 'voiceai.pull', { model: input.model, ...data });
      };
      await report({ status: 'running', percent: 0 });
      void (async () => {
        try {
          const res = await fetch(`${env().OLLAMA_URL}/api/pull`, { method: 'POST', body: JSON.stringify({ model: input.model, stream: true }) });
          if (!res.ok || !res.body) throw new Error(`Ollama antwortet mit ${res.status}`);
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          let last = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.trim()) continue;
              const j = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
              if (j.error) throw new Error(j.error);
              if (j.total && j.completed && Date.now() - last > 1000) {
                last = Date.now();
                await report({ status: 'running', percent: Math.round((j.completed / j.total) * 100), step: j.status });
              }
            }
          }
          await report({ status: 'done', percent: 100 });
        } catch (err: any) {
          await report({ status: 'error', error: String(err?.message ?? err) });
        }
      })();
      return { started: true };
    },
    /** Text-Test des Sprachmodells (ohne Sprachkanal). */
    async 'voiceai.ask'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, text: z.string().min(1).max(500), name: z.string().max(64).default('Tester') }), p);
      const guild = getGuild(ctx, input.guildId);
      const { config: cfg } = await ctx.config.get(guild.id, 'voiceai');
      const t0 = Date.now();
      try {
        const answer = cleanForSpeech(await chat(cfg, guild.name, [], `${input.name}: ${input.text}`));
        return { answer, ms: Date.now() - t0 };
      } catch (err: any) {
        throw new RpcError('DISCORD_ERROR', `Sprachmodell nicht erreichbar: ${err?.message ?? err}`);
      }
    },
    /** Lässt den Bot im aktuellen Sprachkanal einen Text sprechen. */
    async 'voiceai.say'(p, ctx) {
      const input = parse(z.object({ guildId: snowflake, text: z.string().min(1).max(500) }), p);
      const s = sessions.get(input.guildId);
      if (!s) throw new RpcError('VALIDATION', 'Der Bot ist in keinem Sprachkanal. Zuerst beitreten lassen.');
      const { config } = await ctx.config.get(input.guildId, 'voiceai');
      await speak(s, cleanForSpeech(input.text), config).catch((err) => {
        throw new RpcError('DISCORD_ERROR', `Sprachausgabe fehlgeschlagen: ${err?.message ?? err}`);
      });
      return { ok: true };
    },
  },
};
