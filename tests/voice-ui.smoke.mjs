// Optional browser integration check. Build first, then:
// PLAYWRIGHT_MODULE=<path-to-playwright/index.mjs> node --experimental-strip-types tests/voice-ui.smoke.mjs
// Uses a separate server, fake microphone audio and mocked AI responses. No paid API requests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { localVoiceCommand } from '../lib/voice-command.ts';
import { validateMonoWav } from '../lib/audio-wav.ts';

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
      VOICE_AI_ENABLED: 'true',
      VOICE_TRANSCRIPTION_ENABLED: 'true',
      VOICE_TTS_ENABLED: 'false',
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
    window.__tracksStopped = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      if (window.__permissionDelay)
        await new Promise((resolve) =>
          setTimeout(resolve, window.__permissionDelay),
        );
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const destination = audio.createMediaStreamDestination();
      oscillator.frequency.value = 440;
      oscillator.connect(destination);
      oscillator.start();
      await audio.resume();
      const track = destination.stream.getTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => {
        window.__tracksStopped++;
        stop();
        if (audio.state !== 'closed') void audio.close();
      };
      return destination.stream;
    };
    speechSynthesis.speak = () => undefined;
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let uploads = 0;
  let failAudio = false;
  const transcript = '연세대학교 정문에서 홍대입구역까지 준비는 5분';
  await page.route('**/api/transcribe', async (route) => {
    uploads++;
    const body = route.request().postDataBuffer();
    const array = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    );
    assert.ok(validateMonoWav(array).durationSeconds <= 15);
    await delay(250);
    await route.fulfill({
      status: failAudio ? 503 : 200,
      json: failAudio
        ? {
            code: 'unavailable',
            error:
              '음성을 받아쓰지 못했어요. 다시 말하거나 글로 입력해 주세요.',
          }
        : { text: transcript, reason: null, mode: 'cloudflare' },
    });
  });
  await page.route('**/api/voice-intent', async (route) => {
    const { message, pendingSlot } = route.request().postDataJSON();
    await route.fulfill({
      json: {
        ...localVoiceCommand(message, pendingSlot),
        mode: 'model',
        reason: null,
      },
    });
  });
  // Block accidental direct external service requests in the browser as well.
  await page.route('https://api.cloudflare.com/**', () => {
    throw new Error('unexpected external AI request');
  });
  await page.goto('http://127.0.0.1:' + port, { waitUntil: 'networkidle' });
  const start = page.getByRole('button', {
    name: '누르고 있는 동안 출발지와 도착지 말하기. 최대 15초',
    exact: true,
  });
  await start.waitFor();
  const press = async (button) => {
    const box = await button.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  };
  const dialog = page.getByRole('dialog');
  await press(start);
  await page
    .getByRole('heading', { name: '듣고 있어요', exact: true })
    .waitFor();
  await delay(200); // Wait for the sheet's entrance animation before measuring.
  const mic = dialog.locator('button[aria-pressed]');
  const before = await mic.boundingBox();
  await delay(700);
  await page.mouse.up();
  await dialog.getByText(/준비 5분, 이동/).waitFor();
  assert.equal(uploads, 1);
  assert.match(await dialog.innerText(), /홍대입구 방향/);
  const after = await mic.boundingBox();
  assert.ok(
    Math.abs(before.y - after.y) <= 1,
    'microphone moved with changing text',
  );
  assert.ok(await page.evaluate(() => window.__tracksStopped > 0));
  console.log(
    'PASS mobile recording → WAV → mocked AI → demo route → departure guidance; microphone stays fixed',
  );

  await dialog.getByRole('button', { name: '글로 입력', exact: true }).click();
  await dialog.locator('textarea').fill('준비 시간 6분으로 바꿔줘');
  await dialog.getByRole('button', { name: '이 내용으로 찾기' }).click();
  await dialog.getByText(/준비 6분으로 바꿨어요/).waitFor();
  await dialog.getByRole('button', { name: '글로 입력', exact: true }).click();
  await dialog.locator('textarea').fill('몇 분 뒤에 나가면 돼?');
  await dialog.getByRole('button', { name: '이 내용으로 찾기' }).click();
  await dialog.getByText(/준비 6분, 이동/).waitFor();
  assert.match(await dialog.innerText(), /출발하세요/);
  console.log('PASS manual time update and departure question preserve route');

  // Hold without releasing: the real browser timer must cap the recording.
  await press(mic);
  await page
    .getByRole('heading', { name: '듣고 있어요', exact: true })
    .waitFor();
  await dialog.getByText(/준비 5분, 이동/).waitFor({ timeout: 22_000 });
  assert.equal(uploads, 2);
  await page.mouse.up();
  await delay(200);
  assert.equal(uploads, 2);
  console.log(
    'PASS 15-second hold auto-submits once, later release does not record again',
  );

  // A permission grant arriving after release must not record or upload.
  await page.evaluate(() => {
    window.__permissionDelay = 300;
  });
  await press(mic);
  await page.getByRole('heading', { name: '마이크 준비 중' }).waitFor();
  await page.mouse.up();
  await delay(600);
  assert.equal(uploads, 2);
  assert.match(await dialog.innerText(), /녹음을 취소/);
  console.log(
    'PASS release while permission pending closes the late stream, no upload',
  );
  await page.evaluate(() => {
    window.__permissionDelay = 0;
  });

  // Failure stays recoverable, without a second automatic recording.
  failAudio = true;
  await press(mic);
  await page
    .getByRole('heading', { name: '듣고 있어요', exact: true })
    .waitFor();
  await delay(500);
  await page.mouse.up();
  await dialog
    .getByRole('button', { name: '기기 음성인식으로 바꾸기' })
    .waitFor();
  assert.equal(uploads, 3);
  assert.equal(
    await dialog
      .getByRole('button', { name: '글로 입력', exact: true })
      .isEnabled(),
    true,
  );
  console.log('PASS transcription failure offers text/device fallback');

  // Closing while actively recording must discard rather than upload.
  await press(mic);
  await page
    .getByRole('heading', { name: '듣고 있어요', exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await delay(400);
  assert.equal(uploads, 3);
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS close cancels recording; no browser runtime errors');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
