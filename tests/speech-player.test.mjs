import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechPlayer } from '../lib/speech-player.ts';
import { TTS_GENERATION_TIMEOUT_MS } from '../lib/speech-text.ts';

function harness(overrides = {}) {
  const calls = {
    loads: [],
    played: [],
    stopped: 0,
    revoked: [],
    states: [],
    reasons: [],
  };
  const timers = new Map();
  let timerId = 0;
  let time = 0;
  const audio = {
    src: '',
    playbackRate: 1,
    onended: null,
    onerror: null,
    play: async () => {
      calls.played.push(audio.src);
    },
    pause: () => {
      calls.stopped++;
    },
    removeAttribute: () => {
      audio.src = '';
    },
    load: () => undefined,
  };
  const blob = new Blob(['audio'], { type: 'audio/mpeg' });
  const player = createSpeechPlayer(
    {
      onState: (state) => calls.states.push(state),
      onError: (reason) => calls.reasons.push(reason),
    },
    {
      load: async (text, signal) => {
        calls.loads.push({ text, signal });
        return blob;
      },
      createAudio: () => audio,
      createURL: () => 'blob:' + ++timerId,
      revokeURL: (url) => calls.revoked.push(url),
      now: () => time,
      schedule: (callback, ms) => {
        timers.set(++timerId, { callback, ms });
        return timerId;
      },
      unschedule: (id) => timers.delete(id),
      ...overrides,
    },
  );
  return {
    calls,
    audio,
    blob,
    player,
    timers,
    advance: (ms) => {
      time += ms;
    },
  };
}
const normal = { cloud: true, rate: 0.88 };

test('missing Gemini configuration reports an error without playing another voice', async () => {
  const h = harness();
  await h.player.speak('안내', { cloud: false, rate: 0.8 });
  assert.equal(h.calls.loads.length, 0);
  assert.equal(h.calls.played.length, 0);
  assert.deepEqual(h.calls.reasons, ['not_configured']);
  assert.equal(h.calls.states.at(-1).phase, 'idle');
});

test('AI speech plays once, repeated text is cached and object URLs are revoked', async () => {
  const h = harness();
  await h.player.speak('3분 뒤 출발하세요.', normal);
  assert.equal(h.calls.loads.length, 1);
  assert.equal(h.calls.played.length, 1);
  assert.equal(h.audio.playbackRate, 0.88);
  h.audio.onended();
  assert.equal(h.calls.revoked.length, 1);
  await h.player.speak('3분 뒤 출발하세요.', normal);
  assert.equal(h.calls.loads.length, 1);
  h.player.stop();
  assert.equal(h.calls.revoked.length, 2);
  assert.equal(h.calls.states.at(-1).phase, 'idle');
});

test('stop or microphone start prevents late network results from speaking', async () => {
  let resolve;
  const h = harness({
    load: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const job = h.player.speak('이전 경로', normal);
  h.player.stop();
  resolve(h.blob);
  await job;
  assert.equal(h.calls.played.length, 0);
  assert.deepEqual(h.calls.reasons, []);
});

test('cached audio remains cancellable while the browser is starting playback', async () => {
  const h = harness();
  await h.player.prefetch(['안내']);
  let finishPlayback;
  h.audio.play = () =>
    new Promise((resolve) => {
      finishPlayback = resolve;
    });
  const playback = h.player.speak('안내', normal);
  assert.equal(h.calls.states.at(-1).phase, 'loading');
  const audioSource = h.audio.src;
  h.player.unlock();
  assert.equal(h.audio.src, audioSource);
  h.player.stop();
  finishPlayback();
  await playback;
  assert.equal(h.calls.states.at(-1).phase, 'idle');
  assert.deepEqual(h.calls.reasons, []);
  assert.equal(h.timers.size, 0);
});

test('newer guidance replaces older pending generation', async () => {
  const resolve = [];
  const h = harness({ load: () => new Promise((done) => resolve.push(done)) });
  const old = h.player.speak('이전 안내', normal);
  const next = h.player.speak('새 안내', normal);
  resolve[1](h.blob);
  await next;
  resolve[0](h.blob);
  await old;
  assert.equal(h.calls.played.length, 1);
  assert.deepEqual(h.calls.reasons, []);
});

test('network failures and deadlines report errors without switching voices', async () => {
  const failed = harness({
    load: async () => {
      throw new Error('offline');
    },
  });
  await failed.player.speak('안내', normal);
  assert.equal(failed.calls.played.length, 0);
  assert.equal(failed.calls.states.at(-1).phase, 'idle');
  assert.deepEqual(failed.calls.reasons, ['unavailable']);
  const hung = harness({ load: () => new Promise(() => {}) });
  const job = hung.player.speak('안내', normal);
  [...hung.timers.values()]
    .find((timer) => timer.ms === TTS_GENERATION_TIMEOUT_MS)
    .callback();
  await job;
  assert.equal(hung.calls.played.length, 0);
  assert.equal(hung.calls.states.at(-1).phase, 'idle');
  assert.deepEqual(hung.calls.reasons, ['unavailable']);
  assert.equal(hung.timers.size, 0);
});

test('urgent alerts never wait for an uncached network request; prefetched audio is used', async () => {
  const h = harness();
  await h.player.speak('지금 출발하세요.', { ...normal, urgent: true });
  assert.equal(h.calls.loads.length, 0);
  assert.deepEqual(h.calls.reasons, ['urgent']);
  assert.equal(h.calls.states.at(-1).phase, 'idle');
  await h.player.prefetch(['준비를 시작하세요.', '지금 출발하세요.']);
  assert.equal(h.calls.loads.length, 2);
  await h.player.speak('지금 출발하세요.', { ...normal, urgent: true });
  assert.equal(h.calls.loads.length, 2);
  assert.equal(h.calls.played.length, 1);
  h.advance(301_000);
  await h.player.speak('지금 출발하세요.', { ...normal, urgent: true });
  assert.equal(h.calls.loads.length, 2);
  assert.deepEqual(h.calls.reasons, ['urgent', 'urgent']);
});

test('autoplay denial keeps cached audio for a gesture retry and does not get stuck', async () => {
  const h = harness();
  h.audio.play = async () => {
    throw new DOMException('denied', 'NotAllowedError');
  };
  await h.player.speak('안내', normal);
  assert.deepEqual(h.calls.reasons, ['blocked']);
  assert.equal(h.calls.states.at(-1).phase, 'idle');
  assert.equal(h.calls.played.length, 0);
  h.audio.play = async () => {
    h.calls.played.push(h.audio.src);
  };
  await h.player.speak('안내', normal);
  assert.equal(h.calls.loads.length, 1);
  assert.equal(h.calls.states.at(-1).source, 'ai');
});

test('stop cancels speculative generation; dispose ignores subsequent calls', async () => {
  let resolve;
  const h = harness({
    load: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const warm = h.player.prefetch(['출발하세요.']);
  h.player.stop();
  resolve(h.blob);
  await warm;
  await h.player.speak('출발하세요.', { ...normal, urgent: true });
  assert.deepEqual(h.calls.reasons, ['urgent']);
  h.player.dispose();
  await h.player.speak('다른 안내', normal);
  h.player.unlock();
  assert.equal(h.calls.played.length, 0);
});

test('missing arrival information and error guidance use the same Gemini loader', async () => {
  const h = harness();
  for (const text of [
    '최신 버스 도착 정보가 없어 출발 시간을 안내할 수 없어요. 도착 정보를 다시 확인해 주세요.',
    '출발지를 먼저 알려주세요. 현재 위치라고 말해도 돼요.',
    '이 경로의 직행 저상버스를 확인하지 못했어요.',
  ]) {
    await h.player.speak(text, normal);
    assert.equal(h.calls.loads.at(-1).text, text);
    assert.deepEqual(h.calls.states.at(-1), {
      phase: 'speaking',
      source: 'ai',
    });
    h.audio.onended();
  }
  assert.equal(h.calls.played.length, 3);
  assert.deepEqual(h.calls.reasons, []);
});

test('a decoding error stops playback without retrying or substituting a voice', async () => {
  const h = harness();
  await h.player.speak('안내', normal);
  h.audio.onerror();
  assert.deepEqual(h.calls.reasons, ['unavailable']);
  assert.equal(h.calls.played.length, 1);
  assert.equal(h.calls.states.at(-1).phase, 'idle');
  assert.equal(h.audio.src, '');
});
