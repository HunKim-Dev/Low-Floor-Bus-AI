import test from 'node:test';
import assert from 'node:assert/strict';
import { POST as intent } from '../app/api/voice-intent/route.ts';
import { POST as transcribe } from '../app/api/transcribe/route.ts';
import { encodeMonoWav, MAX_AUDIO_BYTES } from '../lib/audio-wav.ts';
import { createRequestGuard } from '../lib/api-input.ts';

const accountId = 'b'.repeat(32);
function configure(t, enabled = true) {
  for (const [name, value] of Object.entries({
    CLOUDFLARE_ACCOUNT_ID: enabled ? accountId : '',
    CLOUDFLARE_API_TOKEN: enabled ? 'test-token-do-not-use' : '',
    VOICE_AI_ENABLED: 'true',
    VOICE_TRANSCRIPTION_ENABLED: 'true',
  })) {
    const original = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
  }
}
const jsonRequest = (body, headers = {}) =>
  new Request('https://app.example/api/voice-intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const wave = () =>
  encodeMonoWav(
    Float32Array.from({ length: 16_000 }, (_, n) => 0.1 * Math.sin(n / 10)),
  );
const audioRequest = (body = wave(), headers = {}) =>
  new Request('https://app.example/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav', ...headers },
    body,
  });

test('API without credentials preserves local intent and refuses audio upload without upstream calls', async (t) => {
  configure(t, false);
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('unexpected external call');
  });
  const result = await intent(jsonRequest({ message: '몇 분 뒤 출발해?' }));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal((await result.json()).action, 'departure');
  const recording = await transcribe(audioRequest());
  assert.equal(recording.status, 503);
  assert.equal((await recording.json()).code, 'not_configured');
});

test('voice APIs reject cross-origin, oversized, invalid-format requests before AI calls', async (t) => {
  configure(t);
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('unexpected external call');
  });
  assert.equal(
    (
      await intent(
        jsonRequest({ message: '서울역' }, { Origin: 'https://evil.example' }),
      )
    ).status,
    403,
  );
  assert.equal(
    (await transcribe(audioRequest(wave(), { 'Sec-Fetch-Site': 'cross-site' })))
      .status,
    403,
  );
  assert.equal(
    (await intent(jsonRequest({ message: '가'.repeat(301) }))).status,
    400,
  );
  assert.equal(
    (
      await intent(
        jsonRequest({ message: '서울역', padding: 'x'.repeat(5000) }),
      )
    ).status,
    413,
  );
  assert.equal(
    (await transcribe(audioRequest(new ArrayBuffer(MAX_AUDIO_BYTES + 1))))
      .status,
    413,
  );
  assert.equal(
    (await transcribe(audioRequest(wave(), { 'Content-Type': 'audio/mp4' })))
      .status,
    415,
  );
  assert.equal(
    (await transcribe(audioRequest(new ArrayBuffer(400)))).status,
    400,
  );
  assert.equal(
    (await intent(jsonRequest({ message: '서울역', pendingSlot: 'malicious' })))
      .status,
    400,
  );
});

test('registered credentials make API issue authenticated requests and return the validated UI contract', async (t) => {
  configure(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init });
    return Response.json({
      success: true,
      result: url.includes('whisper')
        ? { text: '서울역에서 강남역까지' }
        : {
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    action: 'route',
                    originQuery: '서울역',
                    destinationQuery: '강남역',
                    settingsPatch: {
                      preparationMinutes: null,
                      travelMinutes: null,
                      safetyMinutes: null,
                    },
                    clarification: null,
                    clarificationSlot: null,
                  }),
                },
              },
            ],
          },
    });
  });
  const speech = await transcribe(audioRequest());
  assert.equal(speech.status, 200);
  const { text } = await speech.json();
  const response = await intent(jsonRequest({ message: text }));
  const payload = await response.json();
  assert.equal(payload.mode, 'model');
  assert.equal(payload.action, 'route');
  assert.equal(payload.originQuery, '서울역');
  assert.deepEqual(payload.settingsPatch, {});
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      ({ url, init }) =>
        url.includes('/accounts/' + accountId + '/') &&
        init.headers.Authorization === 'Bearer test-token-do-not-use',
    ),
  );
  assert.doesNotMatch(JSON.stringify(payload), /test-token/);
});

test('quota, upstream errors and cancellation produce usable responses without leaked details', async (t) => {
  configure(t);
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: 'secret provider detail' }, { status: 429 }),
  );
  const response = await transcribe(audioRequest());
  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, 'rate_limited');
  const fallback = await intent(
    jsonRequest({ message: '서울역에서 강남역까지' }),
  );
  assert.equal((await fallback.json()).reason, 'model_unavailable');
  const abort = new AbortController();
  abort.abort();
  const cancelled = await transcribe(
    new Request('https://app.example/api/transcribe', {
      method: 'POST',
      body: wave(),
      headers: { 'Content-Type': 'audio/wav' },
      signal: abort.signal,
    }),
  );
  assert.equal(cancelled.status, 408);
});

test('per-instance cost guard blocks after the configured request count', () => {
  const guard = createRequestGuard(2);
  guard();
  guard();
  assert.throws(guard, (error) => error.status === 429);
});
