/**
 * Audio-Hilfsfunktionen für den Sprach-Bot (ohne externe Abhängigkeiten, gut testbar).
 * Discord liefert/erwartet PCM s16le, 48 kHz, Stereo. Whisper arbeitet mit 16 kHz Mono,
 * Piper liefert typischerweise 22,05 kHz Mono.
 */

/** 48 kHz Stereo → 16 kHz Mono (Mittelwert der Kanäle, Mittelung über 3 Samples als einfacher Tiefpass). */
export function discordToWhisper(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 4);
  const outLen = Math.floor(frames / 3);
  const out = Buffer.alloc(outLen * 2);
  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      const f = (i * 3 + k) * 4;
      sum += pcm.readInt16LE(f) + pcm.readInt16LE(f + 2);
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / 6))), i * 2);
  }
  return out;
}

/** Mono-PCM einer beliebigen Abtastrate → 48 kHz Stereo (lineare Interpolation). */
export function toDiscord(mono: Buffer, srcRate: number): Buffer {
  const inSamples = Math.floor(mono.length / 2);
  if (inSamples === 0) return Buffer.alloc(0);
  const ratio = srcRate / 48000;
  const outFrames = Math.floor(inSamples / ratio);
  const out = Buffer.alloc(outFrames * 4);
  for (let i = 0; i < outFrames; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = mono.readInt16LE(Math.min(idx, inSamples - 1) * 2);
    const b = mono.readInt16LE(Math.min(idx + 1, inSamples - 1) * 2);
    const v = Math.round(a + (b - a) * frac);
    out.writeInt16LE(v, i * 4);
    out.writeInt16LE(v, i * 4 + 2);
  }
  return out;
}

/** Lautstärke (RMS, 0–1) – um reine Störgeräusche zu verwerfen. */
export function rms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

export function wavEncode(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Liest eine PCM-16-Bit-WAV-Datei (sucht die Chunks, statt feste Offsets anzunehmen). */
export function wavDecode(buf: Buffer): { sampleRate: number; channels: number; pcm: Buffer } {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Keine WAV-Datei');
  let off = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      sampleRate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error('Nur 16-Bit-PCM wird unterstützt');
      const end = size === 0xffffffff || off + 8 + size > buf.length ? buf.length : off + 8 + size;
      return { sampleRate, channels, pcm: buf.subarray(off + 8, end) };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV ohne Daten');
}

/** Stereo → Mono (für Piper-Ausgaben, die selten Stereo sind). */
export function toMono(pcm: Buffer, channels: number): Buffer {
  if (channels === 1) return pcm;
  const frames = Math.floor(pcm.length / (2 * channels));
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += pcm.readInt16LE((i * channels + c) * 2);
    out.writeInt16LE(Math.round(s / channels), i * 2);
  }
  return out;
}

const UMLAUT: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
export function normalizeSpeech(t: string): string {
  return t
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => UMLAUT[c] ?? c)
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Prüft, ob ein Aktivierungswort vorkommt, und liefert den Text danach.
 * Beispiel: "Hey Rad, wie spät ist es?" → "wie spät ist es?"
 */
export function detectWakeWord(text: string, wakeWords: string[]): { hit: boolean; rest: string } {
  const norm = normalizeSpeech(text);
  for (const w of wakeWords.map(normalizeSpeech).filter(Boolean).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^| )${w.replace(/ /g, ' ')}( |$)`);
    const m = norm.match(re);
    if (m && m.index !== undefined) {
      // Position im Originaltext grob über die Wortanzahl bestimmen
      const wordsBefore = norm.slice(0, m.index + m[0].length).trim().split(' ').length;
      const orig = text.trim().split(/\s+/);
      return { hit: true, rest: orig.slice(wordsBefore).join(' ').replace(/^[,.!?:;\-\s]+/, '').trim() };
    }
  }
  return { hit: false, rest: text.trim() };
}

/** Bereitet KI-Antworten zum Vorlesen auf (kein Markdown, keine Emojis, keine Links). */
export function cleanForSpeech(text: string, maxChars = 600): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_~`#>|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  const cut = cleaned.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut).trim();
}
