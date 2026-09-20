// Capture the actual production UI in its built-in demo mode, without paid API calls.
// Build first. PLAYWRIGHT_MODULE can point to an existing Playwright installation.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || 'playwright'
);
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((done) => probe.close(done));

const server = spawn(
  process.execPath,
  [
    'node_modules/next/dist/bin/next',
    'start',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
  ],
  {
    env: {
      ...process.env,
      KAKAO_REST_API_KEY: '',
      TAGO_BUS_API_KEY: '',
      TAGO_CITY_CODE: '',
      TAGO_NODE_ID: '',
      CLOUDFLARE_ACCOUNT_ID: '',
      CLOUDFLARE_API_TOKEN: '',
      GEMINI_API_KEY: '',
      VOICE_AI_ENABLED: 'false',
      VOICE_TRANSCRIPTION_ENABLED: 'false',
      VOICE_TTS_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
server.stdout.on('data', (data) => {
  output += data;
});
server.stderr.on('data', (data) => {
  output += data;
});
const directory = resolve('docs/screenshots');
let browser;
try {
  for (let i = 0; i < 100 && !output.includes('Ready'); i++) {
    if (server.exitCode !== null)
      throw new Error('Screenshot server failed to start');
    await delay(100);
  }
  if (!output.includes('Ready'))
    throw new Error('Screenshot server readiness timed out');
  await mkdir(directory, { recursive: true });
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({
    viewport: { width: 390, height: 1040 },
    deviceScaleFactor: 2,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const capture = async (name, target = page) => {
    await target.screenshot({
      path: resolve(directory, name + '.png'),
      animations: 'disabled',
    });
    console.log('Captured ' + name);
  };
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
  await page
    .getByText('저상버스 타러 나갈 시간을 알려드려요', { exact: true })
    .waitFor();
  await page
    .getByRole('heading', { name: '버스마중', exact: true })
    .locator('..')
    .screenshot({
      path: resolve(directory, 'brand.png'),
      animations: 'disabled',
    });
  await capture('home');

  await page.getByRole('button', { name: /^출발지 변경/ }).click();
  await page.getByRole('dialog').waitFor();
  await page
    .getByRole('button', { name: '현재 위치에서 출발', exact: true })
    .waitFor();
  await page
    .getByRole('textbox', { name: '장소 검색', exact: true })
    .fill('서울역');
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await page.getByRole('button', { name: /1번, 서울역/ }).waitFor();
  await capture('place-search', page.getByRole('dialog'));
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  await page
    .getByRole('button', { name: '체험 경로로 둘러보기', exact: true })
    .click();
  await page
    .getByRole('heading', { name: '271번 저상버스', exact: true })
    .waitFor();
  await page.getByText('저상 예시', { exact: true }).waitFor();
  await page.evaluate(() => scrollTo(0, 0));
  await capture('recommendation');

  await page.getByText('주변에 물어볼 때', { exact: true }).click();
  await page
    .getByRole('button', { name: '이 문장 읽어주기', exact: true })
    .waitFor();
  await page
    .getByRole('button', { name: '이 문장 읽어주기', exact: true })
    .scrollIntoViewIfNeeded();
  await capture('boarding-guide');
  await page.getByText('주변에 물어볼 때', { exact: true }).click();

  await page.getByText('시간 계산 보기', { exact: true }).click();
  await page
    .getByRole('button', { name: '도착시간 변동 시연', exact: true })
    .scrollIntoViewIfNeeded();
  await capture('departure-timing', page.locator('article'));

  await page.evaluate(() => scrollTo(0, 0));
  await page
    .getByRole('button', { name: '내 이동시간과 알림 설정 열기', exact: true })
    .click();
  await page
    .getByRole('heading', { name: '이동 시간 설정', exact: true })
    .waitFor();
  await capture('settings');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    'Captured 6 screens and the existing app brand. No UI text or API responses were replaced.',
  );
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
}
