// Build first. Optional: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs
// Real Chrome audio decoding with a synthetic WAV response; no live AI calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { encodeMonoWav } from '../lib/audio-wav.ts';
import { localVoiceCommand } from '../lib/voice-command.ts';

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
);
const portProbe = createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const server = spawn(
  process.execPath,
  [
    'node_modules/next/dist/bin/next',
    'start',
    '--port',
    String(port),
    '--hostname',
    '127.0.0.1',
  ],
  {
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      CLOUDFLARE_API_TOKEN: 'test-only-never-send',
      VOICE_AI_ENABLED: 'false',
      VOICE_TRANSCRIPTION_ENABLED: 'false',
      VOICE_TTS_ENABLED: 'true',
      GEMINI_API_KEY: 'test-only-never-send',
      GEMINI_TTS_VOICE: 'Sulafat',
      KAKAO_REST_API_KEY: '',
      TAGO_BUS_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk;
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk;
});
const wave = Buffer.from(
  encodeMonoWav(
    Float32Array.from(
      { length: 16_000 * 6 },
      (_, i) => Math.sin(i * 0.17) * 0.05,
    ),
  ),
);
let browser;
try {
  for (let i = 0; i < 100 && !serverOutput.includes('Ready'); i++) {
    if (server.exitCode !== null) throw new Error(serverOutput);
    await delay(100);
  }
  assert.match(serverOutput, /Ready/);
  browser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
  });
  await context.addInitScript(() => {
    window.__deviceSpeeches = [];
    window.__actualStarts = [];
    const NativeAudio = window.Audio;
    window.Audio = function (...args) {
      const audio = new NativeAudio(...args);
      window.__audio = audio;
      audio.addEventListener('playing', () => {
        if (audio.src.startsWith('blob:'))
          window.__actualStarts.push(audio.src);
      });
      return audio;
    };
    speechSynthesis.speak = (utterance) => {
      window.__deviceSpeeches.push(utterance.text);
    };
    speechSynthesis.cancel = () => undefined;
    window.SpeechRecognition = class {
      start() {}
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let requests = 0;
  const messages = [];
  let fail = false;
  let latency = 150;
  await page.route('**/api/tts', async (route) => {
    requests++;
    const body = route.request().postDataJSON();
    assert.deepEqual(Object.keys(body), ['text']);
    assert.equal(typeof body.text, 'string');
    messages.push(body.text);
    await delay(latency);
    await route
      .fulfill(
        fail
          ? { status: 503, json: { code: 'unavailable' } }
          : { status: 200, contentType: 'audio/wav', body: wave },
      )
      .catch(() => undefined);
  });
  await page.route('**/api/voice-intent', async (route) => {
    const { message, pendingSlot } = route.request().postDataJSON();
    await route.fulfill({
      json: {
        ...localVoiceCommand(message, pendingSlot),
        mode: 'local',
        reason: 'not_configured',
      },
    });
  });
  const openSettings = async () => {
    await page
      .getByRole('button', { name: '내 이동시간과 알림 설정 열기' })
      .click();
    await page.getByText('안내 음성 · Gemini', { exact: true }).waitFor();
  };
  const reset = async () => {
    await page.goto('http://127.0.0.1:' + port, { waitUntil: 'networkidle' });
    await openSettings();
  };
  const preview = () =>
    page.getByRole('button', { name: '미리 듣기', exact: true });
  const stop = () =>
    page.getByRole('button', { name: '음성 멈추기', exact: true });
  const waitForRequest = async (count) => {
    for (let i = 0; i < 50 && requests < count; i++) await delay(20);
    assert.equal(requests, count);
  };
  const startMic = async () => {
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const mic = page.getByRole('button', {
      name: '누르고 있는 동안 출발지와 도착지 말하기. 최대 15초',
      exact: true,
    });
    await mic.click({ trial: true });
    const box = await mic.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page
      .getByRole('heading', { name: '듣고 있어요', exact: true })
      .waitFor();
    assert.equal(await page.evaluate(() => window.__audio?.paused), true);
    await page.keyboard.press('Escape');
    await page.mouse.up();
  };

  await reset();
  assert.equal(requests, 0, 'no page-load synthesis');
  await preview().click();
  await page
    .getByText('Gemini 음성으로 안내하고 있어요.', { exact: true })
    .waitFor();
  assert.equal(requests, 1);
  assert.equal(await page.evaluate(() => window.__audio.paused), false);
  await stop().click();
  assert.equal(await page.evaluate(() => window.__audio.paused), true);
  await preview().click();
  await page
    .getByText('Gemini 음성으로 안내하고 있어요.', { exact: true })
    .waitFor();
  assert.equal(requests, 1, 'replay uses in-memory audio cache');
  assert.equal(await page.evaluate(() => window.__actualStarts.length), 2);
  console.log('PASS real audio decoding, stop and cached replay');

  await page.evaluate(() => {
    localStorage.setItem(
      'bus-majung-settings',
      JSON.stringify({
        voiceOutput: 'device',
        voiceURI: 'legacy-voice',
        voiceRate: 0.8,
      }),
    );
  });
  await reset();
  assert.equal(await page.locator('#voice-source, #voice-choice').count(), 0);
  await preview().click();
  await page
    .getByText('Gemini 음성으로 안내하고 있어요.', { exact: true })
    .waitFor();
  assert.equal(requests, 2);
  assert.equal(await page.evaluate(() => window.__deviceSpeeches.length), 0);
  assert.equal(await page.evaluate(() => window.__audio.playbackRate), 0.8);
  assert.equal(
    await page.evaluate(
      () =>
        'voiceOutput' in
        JSON.parse(localStorage.getItem('bus-majung-settings')),
    ),
    false,
  );
  await stop().click();
  console.log(
    'PASS legacy device preference migrates to Gemini and preserves speed',
  );

  fail = true;
  await reset();
  await preview().click();
  await page
    .getByRole('dialog')
    .getByRole('status')
    .filter({ hasText: 'Gemini 음성을 재생하지 못했어요.' })
    .waitFor();
  assert.equal(await preview().isEnabled(), true);
  assert.equal(await page.evaluate(() => window.__deviceSpeeches.length), 0);
  assert.equal(await page.evaluate(() => window.__actualStarts.length), 0);
  fail = false;
  await preview().click();
  await page
    .getByText('Gemini 음성으로 안내하고 있어요.', { exact: true })
    .waitFor();
  assert.equal(await page.evaluate(() => window.__deviceSpeeches.length), 0);
  await stop().click();
  console.log(
    'PASS TTS failure stays silent, shows an error and retries with Gemini',
  );

  fail = false;
  latency = 900;
  await reset();
  const beforeCancel = requests;
  await preview().click();
  await waitForRequest(beforeCancel + 1);
  await page
    .getByRole('button', { name: '음성 준비 취소', exact: true })
    .click();
  await delay(1100);
  assert.equal(await page.evaluate(() => window.__actualStarts.length), 0);
  assert.equal(await page.evaluate(() => window.__deviceSpeeches.length), 0);
  console.log(
    'PASS cancelling pending synthesis prevents late playback and fallback',
  );

  const beforeMic = requests;
  await preview().click();
  await waitForRequest(beforeMic + 1);
  await startMic();
  await delay(1100);
  assert.equal(await page.evaluate(() => window.__actualStarts.length), 0);
  assert.equal(await page.evaluate(() => window.__deviceSpeeches.length), 0);
  latency = 100;
  await openSettings();
  await preview().click();
  await page
    .getByText('Gemini 음성으로 안내하고 있어요.', { exact: true })
    .waitFor();
  await startMic();
  assert.deepEqual(errors, []);
  console.log(
    'PASS microphone stops pending and playing AI speech; no runtime errors',
  );

  await page.route('**/api/buses?**', (route) =>
    route.fulfill({
      json: {
        mode: 'unavailable',
        buses: [],
        refreshedAt: new Date().toISOString(),
      },
    }),
  );
  await reset();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '체험 경로로 둘러보기' }).click();
  await page.getByRole('heading', { name: '경로는 찾았어요' }).waitFor();
  await page.getByRole('button', { name: '안내 듣기', exact: true }).click();
  await page.waitForFunction(() => window.__actualStarts.length === 1);
  assert.match(messages.at(-1), /타는 곳은 신촌로터리 정류장이에요/);
  assert.match(messages.at(-1), /홍대입구 방향 271번 버스/);
  assert.match(
    messages.at(-1),
    /최신 버스 도착 정보가 없어 출발 시간을 안내할 수 없어요/,
  );
  assert.equal(await page.evaluate(() => window.__deviceSpeeches.length), 0);
  await stop().click();
  console.log(
    'PASS missing arrival information is sent to Gemini and played, never device TTS',
  );

  await page
    .getByRole('button', {
      name: '누르고 있는 동안 출발지와 도착지 말하기. 최대 15초',
      exact: true,
    })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '글로 입력', exact: true }).click();
  await dialog.locator('textarea').fill('몇 분 뒤에 나가면 돼?');
  await dialog.getByRole('button', { name: '이 내용으로 찾기' }).click();
  await dialog
    .getByText(/타는 곳은 신촌로터리 정류장이에요.*최신 버스 도착 정보가 없어/)
    .waitFor();
  await page.waitForFunction(() => window.__actualStarts.length === 2);
  assert.equal(await page.evaluate(() => window.__deviceSpeeches.length), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS assistant departure question with no arrivals also uses Gemini-only playback',
  );

  const boardingTrip = {
    id: 'fixture-route',
    route: '707',
    direction: '시청.교육청 방향',
    nextStopName: '한밭중네거리',
    walkToStopMinutes: 4,
    totalMinutes: 20,
    transfers: 0,
    boardingStop: {
      id: 'test-node',
      name: '대전역',
      number: '01240',
      latitude: 36.33254,
      longitude: 127.43213,
    },
    alightingStop: { name: '시청.교육청' },
    arrivalLookupAvailable: true,
  };
  await page.route('**/api/routes?**', (route) =>
    route.fulfill({ json: { mode: 'live', trip: boardingTrip } }),
  );
  await reset();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '체험 경로로 둘러보기' }).click();
  const guide = page.getByRole('region', { name: '타는 정류장 안내' });
  await guide.getByText('정류장 번호 01240', { exact: true }).waitFor();
  assert.match(await guide.innerText(), /시청.교육청 방향 · 707번/);
  assert.match(await guide.innerText(), /이 버스의 다음 정류장 · 한밭중네거리/);
  assert.equal(
    await guide
      .getByRole('link', { name: /지도에서 타는 곳 보기/ })
      .getAttribute('href'),
    'https://map.kakao.com/link/map/' +
      encodeURIComponent('대전역') +
      ',36.33254,127.43213',
  );
  await guide.getByText('주변에 물어볼 때', { exact: true }).click();
  await guide.getByText(/타는 곳이 어디인지 알려주실 수 있나요/).waitFor();
  await guide.getByRole('button', { name: '이 문장 읽어주기' }).click();
  await page.waitForFunction(() => window.__actualStarts.length === 1);
  assert.match(
    messages.at(-1),
    /대전역.*시청.교육청 방향 707번.*공 일 이 사 공.*한밭중네거리.*알려주실 수 있나요/,
  );
  assert.equal(await page.evaluate(() => window.__deviceSpeeches.length), 0);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
    'no horizontal overflow on mobile',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS mobile boarding card exposes correct map/number/direction and asks for help with Gemini',
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
