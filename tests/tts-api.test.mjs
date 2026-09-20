import test from 'node:test';
import assert from 'node:assert/strict';
import {
  geminiSpeechSettings,
  GEMINI_TTS_MODEL,
  geminiAudioToWave,
  synthesizeSpeech,
} from '../lib/text-to-speech.ts';
import {
  normalizeSpeechText,
  MAX_TTS_AUDIO_BYTES,
} from '../lib/speech-text.ts';
import { POST } from '../app/api/tts/route.ts';
import { restoreSettings } from '../lib/journey.ts';

const credentials = { apiKey: 'test-only-gemini-key' };
const pcm = Buffer.alloc(48_000);
pcm.writeInt16LE(-1234, 0);
const audioPayload = () => ({
  candidates: [
    {
      finishReason: 'STOP',
      content: {
        parts: [
          {
            inlineData: {
              data: pcm.toString('base64'),
              mimeType: 'audio/L16;codec=pcm;rate=24000',
            },
          },
        ],
      },
    },
  ],
});
function configure(t, enabled = true) {
  for (const [name, value] of Object.entries({
    GEMINI_API_KEY: enabled ? credentials.apiKey : '',
    VOICE_TTS_ENABLED: 'true',
    GEMINI_TTS_VOICE: 'Sulafat',
    CLOUDFLARE_ACCOUNT_ID: '',
    CLOUDFLARE_API_TOKEN: '',
  })) {
    const old = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    });
  }
}
const request = (body = { text: '3분 뒤 출발하세요.' }, headers = {}, signal) =>
  new Request('https://bus.example/api/tts', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
    signal,
  });

test('Gemini TTS uses its own server credentials, kill switch and default warm voice', () => {
  assert.equal(geminiSpeechSettings({}).enabled, false);
  assert.equal(
    geminiSpeechSettings({
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      CLOUDFLARE_API_TOKEN: 'token',
    }).enabled,
    false,
  );
  const env = { GEMINI_API_KEY: credentials.apiKey };
  assert.equal(geminiSpeechSettings(env).enabled, true);
  assert.equal(geminiSpeechSettings(env).voice, 'Sulafat');
  assert.equal(
    geminiSpeechSettings({ ...env, VOICE_TTS_ENABLED: 'false' }).enabled,
    false,
  );
  assert.equal(
    geminiSpeechSettings({ ...env, GEMINI_TTS_VOICE: 'Achernar' }).voice,
    'Achernar',
  );
  assert.equal(
    geminiSpeechSettings({ ...env, GEMINI_TTS_VOICE: 'invalid' }).enabled,
    false,
  );
});

test('legacy device TTS preferences are ignored while timing and speed are preserved', () => {
  const settings = restoreSettings({
    voiceOutput: 'device',
    voiceURI: 'old-voice',
    voiceRate: 0.8,
    preparationMinutes: 5,
    voiceAlerts: false,
  });
  assert.equal('voiceOutput' in settings, false);
  assert.equal('voiceURI' in settings, false);
  assert.equal(settings.voiceRate, 0.8);
  assert.equal(settings.preparationMinutes, 5);
  assert.equal(settings.voiceAlerts, false);
});

test('TTS normalizes whitespace without rewriting numbers or truncating instructions', () => {
  assert.equal(
    normalizeSpeechText('  271번\n 버스. 3분 뒤 출발하세요. '),
    '271번 버스. 3분 뒤 출발하세요.',
  );
  for (const value of ['', ' ', null, {}, '가'.repeat(601)])
    assert.throws(() => normalizeSpeechText(value));
});

test('Gemini uses the fixed Flash TTS endpoint, header auth and Korean exact-reading prompt', async () => {
  const text = '서울역에서 271번 버스를 타세요. 3분 뒤 출발하세요.';
  const result = await synthesizeSpeech(text, {
    ...credentials,
    fetcher: async (url, init) => {
      assert.equal(
        url,
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`,
      );
      assert.ok(!url.includes(credentials.apiKey));
      assert.equal(init.headers['x-goog-api-key'], credentials.apiKey);
      assert.equal(init.cache, 'no-store');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.generationConfig, {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Sulafat' } },
        },
      });
      assert.ok(body.contents[0].parts[0].text.endsWith(text));
      assert.match(body.contents[0].parts[0].text, /그대로 읽고/);
      assert.doesNotMatch(
        JSON.stringify(body),
        /accountId|latitude|longitude|apiKey/,
      );
      return Response.json(audioPayload());
    },
  });
  assert.equal(result.contentType, 'audio/wav');
  const wave = Buffer.from(result.bytes);
  assert.equal(wave.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wave.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(wave.readUInt32LE(4), pcm.length + 36);
  assert.equal(wave.readUInt16LE(22), 1);
  assert.equal(wave.readUInt32LE(24), 24_000);
  assert.equal(wave.readUInt16LE(34), 16);
  assert.equal(wave.readUInt32LE(40), pcm.length);
  assert.deepEqual(wave.subarray(44), pcm, 'PCM samples remain unchanged');
});

test('Gemini blocks incomplete/refused, non-audio, malformed and oversized audio', async () => {
  const invalid = [
    null,
    {},
    { promptFeedback: { blockReason: 'SAFETY' }, ...audioPayload() },
  ];
  for (const reason of ['MAX_TOKENS', 'SAFETY', undefined]) {
    const p = audioPayload();
    p.candidates[0].finishReason = reason;
    invalid.push(p);
  }
  for (const mime of [
    'audio/wav',
    'audio/L16;rate=16000',
    'audio/L16;rate=24000;channels=2',
    'text/plain',
  ]) {
    const p = audioPayload();
    p.candidates[0].content.parts[0].inlineData.mimeType = mime;
    invalid.push(p);
  }
  for (const encoded of [
    '',
    'invalid!!!',
    'https://example.com/audio',
    Buffer.alloc(481).toString('base64'),
    Buffer.alloc(MAX_TTS_AUDIO_BYTES).toString('base64'),
  ]) {
    const p = audioPayload();
    p.candidates[0].content.parts[0].inlineData.data = encoded;
    invalid.push(p);
  }
  const textOnly = audioPayload();
  textOnly.candidates[0].content.parts = [{ text: 'no audio' }];
  invalid.push(textOnly);
  const multiple = audioPayload();
  multiple.candidates.push(multiple.candidates[0]);
  invalid.push(multiple);
  for (const p of invalid) assert.throws(() => geminiAudioToWave(p));
  await assert.rejects(
    synthesizeSpeech('안내', {
      ...credentials,
      fetcher: async () => new Response('not JSON'),
    }),
  );
  await assert.rejects(
    synthesizeSpeech('안내', {
      ...credentials,
      fetcher: async () =>
        new Response('x'.repeat(3_000_000), {
          headers: { 'Content-Type': 'application/json' },
        }),
    }),
  );
  await assert.rejects(
    synthesizeSpeech('안내', {
      ...credentials,
      fetcher: async () =>
        new Response('{}', {
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': '3000000',
          },
        }),
    }),
  );
});

test('missing key, unsupported voice and pre-cancelled requests never call Gemini', async (t) => {
  configure(t, false);
  const stub = t.mock.method(globalThis, 'fetch', () =>
    assert.fail('must not fetch'),
  );
  const response = await POST(request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'not_configured');
  await assert.rejects(synthesizeSpeech('안내', {}));
  await assert.rejects(
    synthesizeSpeech('안내', {
      ...credentials,
      voice: 'https://other.example',
    }),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    synthesizeSpeech('안내', { ...credentials, signal: controller.signal }),
  );
  assert.equal(stub.mock.callCount(), 0);
});

test('TTS API rejects cross-origin, invalid, oversized and provider-controlled fields', async (t) => {
  configure(t);
  const stub = t.mock.method(globalThis, 'fetch', () =>
    assert.fail('must not fetch'),
  );
  assert.equal(
    (await POST(request(undefined, { Origin: 'https://evil.example' }))).status,
    403,
  );
  assert.equal(
    (await POST(request(undefined, { 'Content-Type': 'text/plain' }))).status,
    415,
  );
  assert.equal((await POST(request({ text: '' }))).status, 400);
  assert.equal((await POST(request({ text: '가'.repeat(601) }))).status, 400);
  assert.equal((await POST(request({ text: 'x'.repeat(5000) }))).status, 413);
  assert.equal(
    (await POST(request({ text: '안녕', model: 'other' }))).status,
    400,
  );
  assert.equal(
    (await POST(request({ text: '안녕', voice: 'other' }))).status,
    400,
  );
  assert.equal(stub.mock.callCount(), 0);
});

test('TTS API reuses private WAV audio and hides upstream errors on cache misses', async (t) => {
  configure(t);
  const stub = t.mock.method(globalThis, 'fetch', async () =>
    Response.json(audioPayload()),
  );
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-tts-provider'), 'gemini');
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    geminiAudioToWave(audioPayload()),
  );
  stub.mock.mockImplementation(async () =>
    assert.fail('Repeated text must reuse the cached audio'),
  );
  const cached = await POST(request());
  assert.equal(cached.status, 200);
  assert.deepEqual(
    new Uint8Array(await cached.arrayBuffer()),
    geminiAudioToWave(audioPayload()),
  );
  assert.equal(stub.mock.callCount(), 1);
  for (const status of [400, 403, 429, 500]) {
    stub.mock.mockImplementation(async () =>
      Response.json({ detail: credentials.apiKey }, { status }),
    );
    // Use uncached text so each case actually exercises the provider error.
    const failed = await POST(
      request({ text: `${status}번 버스 안내입니다.` }),
    );
    assert.equal(failed.status, status === 429 ? 429 : 503);
    assert.doesNotMatch(await failed.text(), /test-only-gemini-key/);
  }
  assert.equal(stub.mock.callCount(), 5);
});

test('TTS API cancellation returns no audio and the kill switch disables requests', async (t) => {
  configure(t);
  const stub = t.mock.method(globalThis, 'fetch', () =>
    assert.fail('must not fetch'),
  );
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (await POST(request(undefined, {}, controller.signal))).status,
    408,
  );
  process.env.VOICE_TTS_ENABLED = 'false';
  assert.equal((await POST(request())).status, 503);
  assert.equal(stub.mock.callCount(), 0);
});
