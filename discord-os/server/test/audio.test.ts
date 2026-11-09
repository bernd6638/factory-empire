import { describe, expect, it } from 'vitest';
import { cleanForSpeech, detectWakeWord, discordToWhisper, rms, toDiscord, toMono, wavDecode, wavEncode } from '../src/bot/utils/audio';

function sine(freq: number, rate: number, seconds: number, channels: number) {
  const n = Math.floor(rate * seconds);
  const b = Buffer.alloc(n * 2 * channels);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 10000);
    for (let c = 0; c < channels; c++) b.writeInt16LE(v, (i * channels + c) * 2);
  }
  return b;
}

describe('Audio-Umwandlung', () => {
  it('48 kHz Stereo → 16 kHz Mono behält Dauer und Lautstärke', () => {
    const src = sine(440, 48000, 1, 2);
    const out = discordToWhisper(src);
    expect(out.length / 2).toBe(16000);
    expect(rms(out)).toBeGreaterThan(0.18);
  });
  it('22,05 kHz Mono → 48 kHz Stereo', () => {
    const out = toDiscord(sine(220, 22050, 0.5, 1), 22050);
    expect(out.length / 4).toBe(24000);
    expect(out.readInt16LE(400)).toBe(out.readInt16LE(402)); // beide Kanäle gleich
  });
  it('WAV kodieren und wieder lesen', () => {
    const pcm = sine(300, 16000, 0.1, 1);
    const w = wavDecode(wavEncode(pcm, 16000, 1));
    expect(w).toMatchObject({ sampleRate: 16000, channels: 1 });
    expect(w.pcm.equals(pcm)).toBe(true);
    expect(toMono(sine(300, 16000, 0.1, 2), 2).length).toBe(pcm.length);
  });
  it('Stille hat geringe Lautstärke', () => {
    expect(rms(Buffer.alloc(3200))).toBe(0);
  });
});

describe('Aktivierungswort', () => {
  it('erkennt das Wort und liefert den Rest', () => {
    expect(detectWakeWord('Hey Rad, wie spät ist es?', ['hey rad', 'rad'])).toEqual({ hit: true, rest: 'wie spät ist es?' });
    expect(detectWakeWord('Rad erzähl mal einen Witz', ['rad'])).toEqual({ hit: true, rest: 'erzähl mal einen Witz' });
    expect(detectWakeWord('Ich fahre gern Fahrrad', ['rad']).hit).toBe(false);
    expect(detectWakeWord('Hallo Jürgen', ['jürgen']).hit).toBe(true);
  });
});

describe('Text zum Vorlesen', () => {
  it('entfernt Markdown, Emojis und Links und kürzt an Satzgrenzen', () => {
    expect(cleanForSpeech('**Hallo** 😀 schau auf https://x.de - fertig')).toBe('Hallo schau auf - fertig');
    const long = 'Erster Satz ist da. '.repeat(50);
    const out = cleanForSpeech(long, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('.')).toBe(true);
  });
});
