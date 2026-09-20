import {
  encodeMonoWav,
  MAX_RECORDING_SECONDS,
  AUDIO_SAMPLE_RATE,
} from './audio-wav.ts';

type Recorder = Pick<
  MediaRecorder,
  | 'start'
  | 'stop'
  | 'state'
  | 'mimeType'
  | 'ondataavailable'
  | 'onstop'
  | 'onerror'
>;
export type RecordingController = {
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
};
type Callbacks = {
  onReady: () => void;
  onStopped: (cancelled: boolean) => void;
  onAudio: (blob: Blob) => void;
  onError: (error: unknown) => void;
};
type Dependencies = {
  getStream: () => Promise<MediaStream>;
  makeRecorder: (stream: MediaStream) => Recorder;
  schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  unschedule: (timer: ReturnType<typeof setTimeout>) => void;
};

export function supportsCloudRecording() {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    typeof OfflineAudioContext !== 'undefined'
  );
}

// stop/cancel also work while the permission prompt is open. A late permission
// grant closes the stream immediately and must never start another recording.
export function createAudioRecording(
  callbacks: Callbacks,
  overrides: Partial<Dependencies> = {},
): RecordingController {
  const dependencies: Dependencies = {
    getStream: () =>
      navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      }),
    makeRecorder: (stream) => {
      const mimeType = [
        'audio/webm;codecs=opus',
        'audio/mp4',
        'audio/webm',
        'audio/ogg;codecs=opus',
      ].find((type) => MediaRecorder.isTypeSupported(type));
      return new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    },
    schedule: (callback, ms) => setTimeout(callback, ms),
    unschedule: (timer) => clearTimeout(timer),
    ...overrides,
  };
  let stream: MediaStream | null = null;
  let recorder: Recorder | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let stopped = false;
  let finished = false;
  let started = false;
  const chunks: Blob[] = [];
  const cleanup = () => {
    if (timer !== undefined) dependencies.unschedule(timer);
    if (watchdog !== undefined) dependencies.unschedule(watchdog);
    stream?.getTracks().forEach((track) => track.stop());
  };
  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    cleanup();
    chunks.length = 0;
    callbacks.onStopped(true);
    if (!cancelled) callbacks.onError(error);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    cleanup();
    callbacks.onStopped(cancelled);
    if (!cancelled) {
      const blob = new Blob(chunks, {
        type: recorder?.mimeType || chunks[0]?.type,
      });
      if (blob.size) callbacks.onAudio(blob);
      else
        callbacks.onError(new Error('녹음된 소리가 없어요. 다시 말해 주세요.'));
    }
    chunks.length = 0;
  };
  const stop = () => {
    if (finished || stopped) return;
    stopped = true;
    if (!recorder) {
      cancelled = true;
      finish();
      return;
    }
    try {
      // Install the timeout before stop: test recorders can finish synchronously.
      watchdog = dependencies.schedule(
        () => fail(new Error('녹음을 마치지 못했어요. 다시 말해 주세요.')),
        2_000,
      );
      if (recorder.state !== 'inactive') recorder.stop();
      else finish();
      stream?.getTracks().forEach((track) => track.stop());
    } catch (error) {
      fail(error);
    }
  };
  return {
    start: async () => {
      if (started || finished) return;
      started = true;
      try {
        stream = await dependencies.getStream();
        if (stopped || cancelled || finished) {
          cleanup();
          return;
        }
        recorder = dependencies.makeRecorder(stream);
        recorder.ondataavailable = (event) => {
          if (!cancelled && !finished && event.data.size)
            chunks.push(event.data);
        };
        recorder.onerror = () =>
          fail(new Error('마이크 연결이 끊겼어요. 다시 말해 주세요.'));
        recorder.onstop = finish;
        recorder.start();
        timer = dependencies.schedule(stop, MAX_RECORDING_SECONDS * 1_000);
        callbacks.onReady();
      } catch (error) {
        fail(error);
      }
    },
    stop,
    cancel: () => {
      cancelled = true;
      stop();
      cleanup();
    },
  };
}

// Decode the complete WebM/MP4, then resample to a small, predictable WAV.
// The server accepts only this canonical format (16 kHz, mono, PCM16).
export async function recordingBlobToWav(blob: Blob): Promise<ArrayBuffer> {
  if (!blob.size || blob.size > 3_000_000)
    throw new Error('녹음 크기를 확인하지 못했어요. 짧게 다시 말해 주세요.');
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (!Number.isFinite(decoded.duration) || decoded.duration < 0.25)
      throw new Error('녹음이 너무 짧아요. 버튼을 누른 채 말해 주세요.');
    const length = Math.floor(
      Math.min(decoded.duration, MAX_RECORDING_SECONDS) * AUDIO_SAMPLE_RATE,
    );
    const offline = new OfflineAudioContext(1, length, AUDIO_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeMonoWav(rendered.getChannelData(0));
  } finally {
    await context.close().catch(() => undefined);
  }
}
