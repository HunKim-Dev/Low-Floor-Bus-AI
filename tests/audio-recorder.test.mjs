import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioRecording } from '../lib/audio-recorder.ts';

function harness() {
  const calls = {
    ready: 0,
    tracksStopped: 0,
    stop: 0,
    audio: [],
    errors: [],
    cancelled: [],
  };
  const timers = new Map();
  let id = 0;
  const stream = { getTracks: () => [{ stop: () => calls.tracksStopped++ }] };
  const recorder = {
    state: 'inactive',
    mimeType: 'audio/webm',
    start() {
      this.state = 'recording';
    },
    stop() {
      calls.stop++;
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['audio']) });
      this.onstop?.();
    },
  };
  const callbacks = {
    onReady: () => calls.ready++,
    onStopped: (cancelled) => calls.cancelled.push(cancelled),
    onAudio: (blob) => calls.audio.push(blob),
    onError: (error) => calls.errors.push(error),
  };
  const dependencies = {
    getStream: async () => stream,
    makeRecorder: () => recorder,
    schedule: (callback, ms) => {
      timers.set(++id, { callback, ms });
      return id;
    },
    unschedule: (timer) => timers.delete(timer),
  };
  return { calls, timers, stream, recorder, callbacks, dependencies };
}

test('release uploads a complete recording exactly once and stops microphone tracks', async () => {
  const h = harness();
  const session = createAudioRecording(h.callbacks, h.dependencies);
  await session.start();
  assert.equal(h.calls.ready, 1);
  session.stop();
  session.stop();
  assert.equal(h.calls.stop, 1);
  assert.equal(h.calls.audio.length, 1);
  assert.ok(h.calls.tracksStopped > 0);
  assert.equal(h.timers.size, 0);
  assert.equal(await h.calls.audio[0].text(), 'audio');
});

test('15 second deadline stops and submits without a pointer-up event', async () => {
  const h = harness();
  const session = createAudioRecording(h.callbacks, h.dependencies);
  await session.start();
  const limit = [...h.timers.values()].find((timer) => timer.ms === 15_000);
  assert.ok(limit);
  limit.callback();
  session.stop();
  assert.equal(h.calls.audio.length, 1);
});

test('cancel discards audio, stops tracks and clears pending timers', async () => {
  const h = harness();
  const session = createAudioRecording(h.callbacks, h.dependencies);
  await session.start();
  session.cancel();
  assert.equal(h.calls.audio.length, 0);
  assert.equal(h.calls.cancelled.at(-1), true);
  assert.ok(h.calls.tracksStopped > 0);
  assert.equal(h.timers.size, 0);
});

test('release before permission grant never records late and still closes granted tracks', async () => {
  const h = harness();
  let grant;
  const session = createAudioRecording(h.callbacks, {
    ...h.dependencies,
    getStream: () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  });
  const started = session.start();
  session.stop();
  grant(h.stream);
  await started;
  assert.equal(h.calls.ready, 0);
  assert.equal(h.calls.audio.length, 0);
  assert.ok(h.calls.tracksStopped > 0);
});

test('permission denial and recorder failure do not send audio', async () => {
  const h = harness();
  await createAudioRecording(h.callbacks, {
    ...h.dependencies,
    getStream: async () => {
      throw new Error('denied');
    },
  }).start();
  assert.equal(h.calls.errors.length, 1);
  assert.equal(h.calls.audio.length, 0);
  const live = harness();
  await createAudioRecording(live.callbacks, live.dependencies).start();
  live.recorder.onerror();
  live.recorder.onstop();
  assert.equal(live.calls.audio.length, 0);
  assert.equal(live.calls.errors.length, 1);
  assert.ok(live.calls.tracksStopped > 0);
});
