import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cloudflareSettings,
  cloudflareStructuredOutput,
  runCloudflareModel,
  CLOUDFLARE_INTENT_MODEL,
  CLOUDFLARE_SPEECH_MODEL,
} from '../lib/cloudflare-ai.ts';
import { interpretCloudflareVoice } from '../lib/cloudflare-voice-intent.ts';
import {
  localVoiceCommand,
  validateVoiceCommand,
  applyTimingPatch,
} from '../lib/voice-command.ts';
import { mergeVoiceDraft, resolveVoiceDraft } from '../lib/voice-journey.ts';
import {
  encodeMonoWav,
  validateMonoWav,
  MAX_AUDIO_BYTES,
} from '../lib/audio-wav.ts';
import { transcribeAudio } from '../lib/transcription.ts';
import {
  defaultSettings,
  stampArrivals,
  createAlertPlan,
} from '../lib/journey.ts';
import { departureGuidance } from '../lib/departure-guidance.ts';
import { demoPlaces, createDemoTrip } from '../lib/trip-planning.ts';

const credentials = {
  accountId: 'a'.repeat(32),
  apiToken: 'test-only-not-a-secret',
};
const env = {
  CLOUDFLARE_ACCOUNT_ID: credentials.accountId,
  CLOUDFLARE_API_TOKEN: credentials.apiToken,
};
const reply = (result) => Response.json({ success: true, result });
const route = {
  action: 'route',
  originQuery: '현재 위치',
  destinationQuery: '서울역',
  settingsPatch: {
    preparationMinutes: 5,
    travelMinutes: null,
    safetyMinutes: null,
  },
  clarification: null,
  clarificationSlot: null,
};
const audio = () =>
  encodeMonoWav(
    Float32Array.from({ length: 16_000 }, (_, n) => 0.1 * Math.sin(n / 10)),
  );

test('Cloudflare capabilities activate only with credentials and support independent kill switches', () => {
  assert.equal(cloudflareSettings({}).speechEnabled, false);
  assert.equal(
    cloudflareSettings({ ...env, CLOUDFLARE_ACCOUNT_ID: 'wrong' })
      .intentEnabled,
    false,
  );
  assert.equal(cloudflareSettings(env).speechEnabled, true);
  assert.equal(cloudflareSettings(env).intentEnabled, true);
  assert.equal(cloudflareSettings(env).intentModel, CLOUDFLARE_INTENT_MODEL);
  assert.equal(
    cloudflareSettings({ ...env, VOICE_TRANSCRIPTION_ENABLED: 'false' })
      .speechEnabled,
    false,
  );
  assert.equal(
    cloudflareSettings({ ...env, VOICE_AI_ENABLED: 'false' }).intentEnabled,
    false,
  );
});

test('no credentials means no external AI request and still a useful local command', async () => {
  const result = await interpretCloudflareVoice(
    '현재 위치에서 서울역까지, 준비는 오분',
    null,
    {
      fetcher: () => {
        throw new Error('unexpected network request');
      },
    },
  );
  assert.equal(result.mode, 'local');
  assert.equal(result.reason, 'not_configured');
  assert.equal(result.originQuery, '현재 위치');
  assert.equal(result.destinationQuery, '서울역');
  assert.deepEqual(result.settingsPatch, { preparationMinutes: 5 });
});

test('Qwen request uses official REST auth/schema and only text plus pending slot', async () => {
  const result = await interpretCloudflareVoice(
    '현재 위치에서 서울역까지 준비는 5분',
    null,
    {
      ...credentials,
      fetcher: async (url, init) => {
        assert.equal(
          url,
          'https://api.cloudflare.com/client/v4/accounts/' +
            credentials.accountId +
            '/ai/run/' +
            CLOUDFLARE_INTENT_MODEL,
        );
        assert.equal(
          init.headers.Authorization,
          'Bearer ' + credentials.apiToken,
        );
        const body = JSON.parse(init.body);
        assert.deepEqual(
          Object.keys(JSON.parse(body.messages[1].content)).sort(),
          ['message', 'pendingSlot'],
        );
        assert.equal(body.response_format.type, 'json_schema');
        assert.equal(
          body.response_format.json_schema.additionalProperties,
          false,
        );
        assert.equal(body.stream, false);
        assert.equal(init.cache, 'no-store');
        return reply({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify(route) },
            },
          ],
        });
      },
    },
  );
  assert.equal(result.mode, 'model');
  assert.deepEqual(result.settingsPatch, { preparationMinutes: 5 });
});

test('JSON object/string responses work, refusals/truncation/reasoning do not', () => {
  assert.deepEqual(cloudflareStructuredOutput({ response: route }), route);
  assert.deepEqual(
    cloudflareStructuredOutput({ response: JSON.stringify(route) }),
    route,
  );
  for (const response of [
    { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
    {
      choices: [
        { finish_reason: 'stop', message: { refusal: 'no', content: '{}' } },
      ],
    },
    {
      choices: [
        { finish_reason: 'stop', message: { reasoning_content: '{}' } },
      ],
    },
    { response: 'not JSON' },
  ])
    assert.throws(() => cloudflareStructuredOutput(response));
});

test('invalid, fabricated settings and network failures safely fall back', async () => {
  for (const fetcher of [
    async () => reply({ response: { ...route, latitude: 37 } }),
    async () =>
      reply({
        response: { ...route, settingsPatch: { preparationMinutes: 100 } },
      }),
    async () =>
      reply({
        response: { ...route, settingsPatch: { preparationMinutes: 7 } },
      }),
    async () => Response.json({ secret: 'never echo' }, { status: 401 }),
    async () => {
      throw new Error('timeout');
    },
  ]) {
    const result = await interpretCloudflareVoice(
      '현재 위치에서 서울역까지 준비는 5분',
      null,
      { ...credentials, fetcher },
    );
    assert.equal(result.mode, 'local');
    assert.equal(result.reason, 'model_unavailable');
    assert.deepEqual(result.settingsPatch, { preparationMinutes: 5 });
    assert.equal(result.destinationQuery, '서울역');
  }
  assert.throws(() =>
    validateVoiceCommand({ ...route, settingsPatch: { safetyMinutes: 0 } }),
  );
  assert.throws(() => validateVoiceCommand({ ...route, action: 'departure' }));
});

test('Cloudflare endpoint cannot be redirected by a configured model string', async () => {
  await assert.rejects(
    runCloudflareModel(
      'https://other.example/model',
      {},
      {
        ...credentials,
        fetcher: () => {
          throw new Error('must not fetch');
        },
      },
    ),
    /configuration_error/,
  );
});

test('local commands distinguish time updates, departure questions and mixed routes', () => {
  for (const question of [
    '언제 나가야 해?',
    '몇 분 뒤에 출발해?',
    '몇 시에 출발해?',
    '지금 나가도 돼?',
  ])
    assert.equal(localVoiceCommand(question, null).action, 'departure');
  assert.equal(localVoiceCommand('취소', 'origin').action, 'cancel');
  for (const request of [
    '준비는 5분이고 서울역에서 강남역까지',
    '서울역에서 강남역까지 준비는 5분',
  ]) {
    const command = localVoiceCommand(request, null);
    assert.equal(command.action, 'route');
    assert.equal(command.originQuery, '서울역');
    assert.equal(command.destinationQuery, '강남역');
    assert.equal(command.settingsPatch.preparationMinutes, 5);
  }
  assert.equal(localVoiceCommand('준비는 100분', null).action, 'unknown');
  assert.equal(
    localVoiceCommand('준비 시간 5분으로 바꿔줘', null).action,
    'settings',
  );
  const travel = localVoiceCommand('정류장까지 8분 걸려', null);
  assert.equal(travel.action, 'settings');
  assert.equal(
    applyTimingPatch(defaultSettings, travel.settingsPatch).automaticTravelTime,
    false,
  );
});

test('Whisper audio is canonical Korean PCM, silence never reaches upstream', async () => {
  const wave = audio();
  assert.equal(validateMonoWav(wave).durationSeconds, 1);
  assert.equal(
    encodeMonoWav(new Float32Array(16_000 * 20)).byteLength,
    MAX_AUDIO_BYTES,
  );
  const result = await transcribeAudio(wave, {
    ...credentials,
    fetcher: async (url, init) => {
      assert.ok(url.endsWith(CLOUDFLARE_SPEECH_MODEL));
      const input = JSON.parse(init.body);
      assert.equal(input.language, 'ko');
      assert.equal(input.task, 'transcribe');
      assert.equal(input.condition_on_previous_text, false);
      assert.deepEqual(Buffer.from(input.audio, 'base64'), Buffer.from(wave));
      return reply({ text: ' 현재 위치에서  서울역까지 ' });
    },
  });
  assert.equal(result.text, '현재 위치에서 서울역까지');
  const silent = await transcribeAudio(
    encodeMonoWav(new Float32Array(16_000)),
    {
      ...credentials,
      fetcher: () => {
        throw new Error('must not send silence');
      },
    },
  );
  assert.equal(silent.reason, 'no_speech');
  const invalid = wave.slice(0);
  new DataView(invalid).setUint32(24, 48_000, true);
  assert.throws(() => validateMonoWav(invalid));
  assert.throws(() => validateMonoWav(new ArrayBuffer(MAX_AUDIO_BYTES + 2)));
});

test('Whisper missing text fails and too-long/no-speech output cannot become a route', async () => {
  await assert.rejects(
    transcribeAudio(audio(), {
      ...credentials,
      fetcher: async () => reply({}),
    }),
  );
  for (const [result, reason] of [
    [{ text: '가'.repeat(301) }, 'too_long'],
    [
      {
        text: '시청해 주셔서 감사합니다',
        segments: [{ no_speech_prob: 0.99 }],
      },
      'no_speech',
    ],
  ]) {
    const output = await transcribeAudio(audio(), {
      ...credentials,
      fetcher: async () => reply(result),
    });
    assert.equal(output.reason, reason);
    assert.equal(output.text, '');
  }
});

test('mocked speech → model → real-place resolution → deterministic departure works end to end', async () => {
  const transcript = await transcribeAudio(audio(), {
    ...credentials,
    fetcher: async () => reply({ text: '현재 위치에서 서울역까지 준비는 5분' }),
  });
  const command = await interpretCloudflareVoice(transcript.text, null, {
    ...credentials,
    fetcher: async () => reply({ response: route }),
  });
  const origin = demoPlaces[0];
  const destination = demoPlaces.find((place) => place.name === '서울역');
  const resolved = await resolveVoiceDraft(
    mergeVoiceDraft(null, command, null, null, command.settingsPatch),
    {
      locate: async () => origin,
      search: async () => ({ mode: 'live', places: [destination] }),
    },
  );
  assert.equal(resolved.kind, 'complete');
  const settings = applyTimingPatch(
    defaultSettings,
    resolved.draft.settingsPatch,
  );
  assert.equal(settings.preparationMinutes, 5);
  const now = 1_800_000_000_000;
  const trip = { ...createDemoTrip(origin, destination), walkToStopMinutes: 4 };
  const state = {
    origin,
    destination,
    trip,
    settings,
    tripBusy: false,
    busesBusy: false,
    tripError: null,
    tripMode: 'live',
    dataMode: 'live',
    lastUpdatedAt: now,
    buses: stampArrivals(
      [{ id: '1', route: '150', etaMinutes: 20, lowFloor: true }],
      now,
    ),
  };
  // 20 - (4 * 1.5) - 2 = 12 minutes; 5 minutes preparation starts at 7.
  assert.match(departureGuidance(state, now), /7분 뒤 준비하고, 12분 뒤/);
  assert.match(
    departureGuidance(state, now + 30_000),
    /6분 뒤 준비하고, 11분 뒤/,
  );
  assert.match(
    departureGuidance({ ...state, lastUpdatedAt: now - 91_000 }, now),
    /최신 버스 도착 정보가 없어/,
  );
  assert.match(
    departureGuidance({ ...state, buses: [] }, now),
    /저상버스가 아직 없어요/,
  );
  assert.match(
    departureGuidance({ ...state, dataMode: 'demo', tripMode: 'demo' }, now),
    /체험용 안내/,
  );
  assert.match(
    departureGuidance({ ...state, destination: null }, now),
    /도착지/,
  );
  assert.match(
    departureGuidance({ ...state, tripBusy: true }, now),
    /확인하고 있어요/,
  );
  const alertPlan = createAlertPlan(state.buses[0], {
    ...settings,
    travelMinutes: 6,
  });
  const preparingAt = now + 9 * 60_000;
  // Once an alert is tracking preparation, do not require the full preparation
  // time again or recommend a different bus than the screen.
  assert.match(
    departureGuidance(
      { ...state, alertPlan, lastUpdatedAt: preparingAt },
      preparingAt,
    ),
    /준비를 마치고 3분 뒤/,
  );
  assert.match(
    departureGuidance(
      { ...state, dataMode: 'demo', tripMode: 'demo' },
      now + 120_000,
    ),
    /체험용 안내/,
  );
});

test('ambiguous place selection preserves unapplied timing changes until route is confirmed', async () => {
  const origin = demoPlaces[0];
  const destination = demoPlaces[1];
  const branch = { ...origin, id: 'second', latitude: origin.latitude + 0.01 };
  const first = await resolveVoiceDraft(
    mergeVoiceDraft(
      null,
      { originQuery: origin.name, destinationQuery: destination.name },
      null,
      null,
      { preparationMinutes: 5 },
    ),
    {
      search: async () => ({ mode: 'live', places: [origin, branch] }),
      locate: async () => origin,
    },
  );
  assert.equal(first.kind, 'choose');
  const next = mergeVoiceDraft(
    { ...first.draft, origin },
    { originQuery: '', destinationQuery: '' },
    null,
    null,
  );
  const second = await resolveVoiceDraft(next, {
    search: async () => ({ mode: 'live', places: [destination] }),
    locate: async () => origin,
  });
  assert.equal(second.kind, 'complete');
  assert.deepEqual(second.draft.settingsPatch, { preparationMinutes: 5 });
});
