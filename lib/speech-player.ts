import {
  MAX_TTS_AUDIO_BYTES,
  normalizeSpeechText,
  TTS_GENERATION_TIMEOUT_MS,
} from './speech-text.ts';

export type SpeechState = {
  phase: 'idle' | 'loading' | 'speaking';
  source: 'ai' | null;
};
export type SpeechFailure =
  | 'unavailable'
  | 'blocked'
  | 'urgent'
  | 'not_configured';
export type SpeechOptions = { cloud: boolean; rate: number; urgent?: boolean };
type AudioLike = Pick<
  HTMLAudioElement,
  | 'src'
  | 'play'
  | 'pause'
  | 'load'
  | 'removeAttribute'
  | 'playbackRate'
  | 'onended'
  | 'onerror'
>;
type Dependencies = {
  load: (text: string, signal: AbortSignal) => Promise<Blob>;
  createAudio: () => AudioLike;
  createURL: (blob: Blob) => string;
  revokeURL: (url: string) => void;
  onState: (state: SpeechState) => void;
  onError: (reason: SpeechFailure) => void;
  now: () => number;
  schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  unschedule: (timer: ReturnType<typeof setTimeout>) => void;
};
const SILENT_WAV =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQQAAAAAAAAA';
const CACHE_TTL = 5 * 60_000;

async function fetchSpeech(text: string, signal: AbortSignal) {
  const response = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
    cache: 'no-store',
  });
  if (
    !response.ok ||
    !['audio/mpeg', 'audio/wav'].includes(
      response.headers.get('content-type')?.split(';')[0] ?? '',
    )
  )
    throw new Error('speech unavailable');
  if (Number(response.headers.get('content-length')) > MAX_TTS_AUDIO_BYTES)
    throw new Error('oversized speech');
  const blob = await response.blob();
  if (!blob.size || blob.size > MAX_TTS_AUDIO_BYTES)
    throw new Error('invalid speech');
  return blob;
}

// One audio element, one active utterance. Late network/playback completions
// cannot speak after stop(), a new utterance, microphone start or unmount.
export function createSpeechPlayer(
  callbacks: Pick<Dependencies, 'onState' | 'onError'>,
  overrides: Partial<Dependencies> = {},
) {
  const deps: Dependencies = {
    load: fetchSpeech,
    createAudio: () => new Audio(),
    createURL: (blob) => URL.createObjectURL(blob),
    revokeURL: (url) => URL.revokeObjectURL(url),
    now: Date.now,
    schedule: (callback, ms) => setTimeout(callback, ms),
    unschedule: (timer) => clearTimeout(timer),
    ...callbacks,
    ...overrides,
  };
  let generation = 0;
  let disposed = false;
  let audio: AudioLike | null = null;
  let url: string | null = null;
  let active: AbortController | null = null;
  let state: SpeechState = { phase: 'idle', source: null };
  const cache = new Map<string, { blob: Blob; expiresAt: number }>();
  const warming = new Map<string, AbortController>();
  const emit = (next: SpeechState) => {
    state = next;
    if (!disposed) deps.onState(next);
  };
  const releaseAudio = () => {
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (url) {
      deps.revokeURL(url);
      url = null;
    }
  };
  const stopCurrent = () => {
    generation++;
    active?.abort();
    active = null;
    releaseAudio();
    emit({ phase: 'idle', source: null });
  };
  const stop = () => {
    stopCurrent();
    for (const controller of warming.values()) controller.abort();
    warming.clear();
  };
  const getCached = (text: string) => {
    const entry = cache.get(text);
    if (!entry) return null;
    if (entry.expiresAt <= deps.now()) {
      cache.delete(text);
      return null;
    }
    cache.delete(text);
    cache.set(text, entry);
    return entry.blob;
  };
  const cacheBlob = (text: string, blob: Blob) => {
    if (!blob.size || blob.size > MAX_TTS_AUDIO_BYTES)
      throw new Error('invalid speech');
    cache.delete(text);
    cache.set(text, { blob, expiresAt: deps.now() + CACHE_TTL });
    while (
      cache.size > 8 ||
      [...cache.values()].reduce((sum, entry) => sum + entry.blob.size, 0) >
        8_000_000
    )
      cache.delete(cache.keys().next().value!);
  };
  const withinDeadline = async <T>(
    job: Promise<T>,
    controller: AbortController,
    ms: number,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    try {
      return await Promise.race([
        job,
        new Promise<never>((_, reject) => {
          aborted = () => reject(new Error('cancelled'));
          controller.signal.addEventListener('abort', aborted, { once: true });
          if (controller.signal.aborted) {
            aborted();
            return;
          }
          timer = deps.schedule(() => {
            controller.abort();
            reject(new Error('timeout'));
          }, ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) deps.unschedule(timer);
      if (aborted) controller.signal.removeEventListener('abort', aborted);
    }
  };

  return {
    // Call during a user gesture. Safari may still deny later playback; speak()
    // handles NotAllowedError and the UI retains an explicit replay button.
    unlock: () => {
      if (disposed || state.phase !== 'idle') return;
      try {
        audio ??= deps.createAudio();
        if (audio.src === SILENT_WAV) return;
        audio.src = SILENT_WAV;
        void audio.play().catch(() => undefined);
      } catch {
        /* speak() reports playback failures; never substitute another voice. */
      }
    },
    stop,
    dispose: () => {
      disposed = true;
      stop();
      cache.clear();
      audio = null;
    },
    prefetch: async (messages: string[]) => {
      if (disposed) return;
      await Promise.all(
        messages.slice(0, 2).map(async (message) => {
          let text: string;
          try {
            text = normalizeSpeechText(message);
          } catch {
            return;
          }
          if (getCached(text) || warming.has(text) || warming.size >= 2) return;
          const request = new AbortController();
          warming.set(text, request);
          try {
            const blob = await withinDeadline(
              deps.load(text, request.signal),
              request,
              TTS_GENERATION_TIMEOUT_MS,
            );
            if (!disposed && !request.signal.aborted) cacheBlob(text, blob);
          } catch {
            /* Never delay an alert or show an error for speculative warming. */
          } finally {
            if (warming.get(text) === request) warming.delete(text);
          }
        }),
      );
    },
    speak: async (message: string, options: SpeechOptions) => {
      if (disposed) return;
      stopCurrent();
      const current = generation;
      const stillCurrent = () => !disposed && current === generation;
      const finish = () => {
        if (!stillCurrent()) return;
        releaseAudio();
        active = null;
        emit({ phase: 'idle', source: null });
      };
      const fail = (reason: SpeechFailure) => {
        if (!stillCurrent()) return;
        active?.abort();
        finish();
        deps.onError(reason);
      };
      if (!options.cloud) {
        fail('not_configured');
        return;
      }
      let text: string;
      try {
        text = normalizeSpeechText(message);
      } catch {
        fail('unavailable');
        return;
      }
      let blob = getCached(text);
      if (options.urgent && !blob) {
        // Text, notification and vibration are handled immediately by the UI.
        // Do not speak a stale departure command after network generation.
        fail('urgent');
        return;
      }
      const request = new AbortController();
      active = request;
      // Cached audio may still need buffering or a browser permission decision.
      // Keep stop available, and prevent unlock() from replacing its source.
      emit({ phase: 'loading', source: 'ai' });
      if (!blob) {
        try {
          blob = await withinDeadline(
            deps.load(text, request.signal),
            request,
            TTS_GENERATION_TIMEOUT_MS,
          );
          if (!stillCurrent()) return;
          cacheBlob(text, blob);
        } catch {
          if (stillCurrent()) fail('unavailable');
          return;
        }
      }
      if (!stillCurrent()) return;
      try {
        audio ??= deps.createAudio();
        url = deps.createURL(blob);
        audio.src = url;
        audio.playbackRate = Math.max(0.7, Math.min(1.2, options.rate));
        audio.onended = finish;
        audio.onerror = () => {
          // Never restart a partly spoken, time-sensitive instruction.
          fail('unavailable');
        };
        await withinDeadline(
          audio.play(),
          request,
          options.urgent ? 500 : 3_000,
        );
        if (!stillCurrent() || active !== request || request.signal.aborted)
          return;
        emit({ phase: 'speaking', source: 'ai' });
      } catch (error) {
        if (stillCurrent() && active === request)
          fail(
            error instanceof Error && error.name === 'NotAllowedError'
              ? 'blocked'
              : 'unavailable',
          );
      }
    },
  };
}

export type SpeechPlayer = ReturnType<typeof createSpeechPlayer>;
