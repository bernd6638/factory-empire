import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitSentences } from '../src/bot/modules/voiceai';

describe('Sprach-Bot: Satzweise Ausgabe', () => {
  it('trennt fertige Sätze ab und behält den Rest', () => {
    const r = splitSentences('Hallo, schön dich zu hören! Mir geht es gut. Und d');
    expect(r.sentences).toEqual(['Hallo, schön dich zu hören!']);
    // „Mir geht es gut.“ ist kurz und wartet auf den nächsten Satz
    expect(r.rest).toBe('Mir geht es gut. Und d');
  });
  it('kurze Stücke werden mit dem nächsten Satz zusammengefasst', () => {
    expect(splitSentences('Ja. Das ist eine gute Frage. ').sentences).toEqual(['Ja. Das ist eine gute Frage.']);
  });
});

describe('Sprach-Bot: Streaming vom Sprachmodell', () => {
  let server: http.Server;
  beforeAll(async () => {
    // Simuliertes Ollama: liefert die Antwort Token für Token mit Verzögerung
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const tokens = ['Hallo ', 'Bernd, ', 'ich höre ', 'dich gut. ', 'Wie ', 'kann ich ', 'dir helfen?'];
      let i = 0;
      const t = setInterval(() => {
        if (i < tokens.length) res.write(JSON.stringify({ message: { content: tokens[i++] } }) + '\n');
        else {
          res.end(JSON.stringify({ done: true }) + '\n');
          clearInterval(t);
        }
      }, 40);
    });
    await new Promise<void>((r) => server.listen(0, r));
    process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('liefert den ersten Satz, bevor die Antwort vollständig ist', async () => {
    const { chatSentences } = await import('../src/bot/modules/voiceai');
    const { defaultModuleConfig } = await import('../src/shared/modules');
    const t0 = Date.now();
    const got: { s: string; ms: number }[] = [];
    for await (const s of chatSentences(defaultModuleConfig('voiceai'), 'Test', [], 'Bernd: hörst du mich?')) got.push({ s, ms: Date.now() - t0 });
    expect(got.map((g) => g.s)).toEqual(['Hallo Bernd, ich höre dich gut.', 'Wie kann ich dir helfen?']);
    expect(got[0]!.ms).toBeLessThan(got[1]!.ms - 80); // erster Satz deutlich früher verfügbar
  });
});
