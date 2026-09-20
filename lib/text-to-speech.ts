// Server-only Gemini TTS adapter. Never expose credentials to the browser.
import { Buffer } from 'node:buffer';
import {
  MAX_TTS_AUDIO_BYTES,
  normalizeSpeechText,
  TTS_GENERATION_TIMEOUT_MS,
  dailyQuotaRetrySeconds,
} from './speech-text.ts';

export const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
export const GEMINI_TTS_VOICES = ['Sulafat', 'Achernar', 'Kore'] as const;
type Voice = (typeof GEMINI_TTS_VOICES)[number];
type SpeechOptions = {
  apiKey?: string;
  voice?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
};

export class SpeechError extends Error {
  code:
    | 'not_configured'
    | 'configuration_error'
    | 'rate_limited'
    | 'daily_limit'
    | 'unavailable';
  retryAfterSeconds?: number;
  constructor(code: SpeechError['code'], retryAfterSeconds?: number) {
    super(code);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function geminiSpeechSettings(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.GEMINI_API_KEY?.trim();
  const voice = env.GEMINI_TTS_VOICE?.trim() || 'Sulafat';
  return {
    apiKey,
    voice,
    enabled:
      env.VOICE_TTS_ENABLED !== 'false' &&
      !!apiKey &&
      GEMINI_TTS_VOICES.includes(voice as Voice),
  };
}

async function boundedResponse(
  response: Response,
  limit: number,
  signal: AbortSignal,
) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new SpeechError('unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SpeechError('unavailable');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new SpeechError('unavailable');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

// Gemini returns raw PCM16 little-endian, mono, 24 kHz (not an MP3/WAV file).
// Wrap the verified format in WAV so Safari and Chrome can both play it.
export function geminiAudioToWave(payload: unknown) {
  const result = payload as {
    promptFeedback?: { blockReason?: unknown };
    candidates?: {
      finishReason?: unknown;
      content?: {
        parts?: {
          inlineData?: { data?: unknown; mimeType?: unknown };
        }[];
      };
    }[];
  } | null;
  const candidate = result?.candidates?.[0];
  const parts = candidate?.content?.parts;
  const data = parts?.[0]?.inlineData;
  if (
    result?.promptFeedback?.blockReason ||
    result?.candidates?.length !== 1 ||
    candidate?.finishReason !== 'STOP' ||
    !Array.isArray(parts) ||
    parts.length !== 1 ||
    typeof data?.mimeType !== 'string' ||
    typeof data.data !== 'string'
  ) {
    throw new SpeechError('unavailable');
  }
  const mime = data.mimeType
    .toLowerCase()
    .split(';')
    .map((part) => part.trim());
  if (
    mime[0] !== 'audio/l16' ||
    !mime.includes('rate=24000') ||
    mime
      .slice(1)
      .some(
        (part) => !['rate=24000', 'codec=pcm', 'channels=1'].includes(part),
      ) ||
    !data.data ||
    data.data.length > Math.ceil((MAX_TTS_AUDIO_BYTES * 4) / 3) ||
    data.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(data.data)
  ) {
    throw new SpeechError('unavailable');
  }
  const pcm = Buffer.from(data.data, 'base64');
  if (
    pcm.length < 480 ||
    pcm.length % 2 !== 0 ||
    pcm.length + 44 > MAX_TTS_AUDIO_BYTES ||
    pcm.toString('base64') !== data.data
  )
    throw new SpeechError('unavailable');
  const wave = Buffer.alloc(44 + pcm.length);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(24_000, 24);
  wave.writeUInt32LE(48_000, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(pcm.length, 40);
  pcm.copy(wave, 44);
  return new Uint8Array(wave);
}

export async function synthesizeSpeech(
  message: string,
  options: SpeechOptions = {},
) {
  const text = normalizeSpeechText(message);
  if (!options.apiKey?.trim()) throw new SpeechError('not_configured');
  const voice = options.voice ?? 'Sulafat';
  if (!GEMINI_TTS_VOICES.includes(voice as Voice))
    throw new SpeechError('configuration_error');
  const signal = AbortSignal.any([
    ...(options.signal ? [options.signal] : []),
    AbortSignal.timeout(TTS_GENERATION_TIMEOUT_MS - 2_000),
  ]);
  signal.throwIfAborted();
  const response = await (options.fetcher ?? fetch)(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': options.apiKey.trim(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: [
                  '차분하고 따뜻한 한국어 안내 목소리로 자연스럽고 또렷하게 읽어 주세요.',
                  '과장하거나 연기하지 마세요. 아래 안내 문장만 그대로 읽고 설명을 덧붙이지 마세요.',
                  '버스 번호, 정류장 이름, 시간과 숫자를 생략하거나 바꾸지 마세요.',
                  '안내 문장:',
                  text,
                ].join('\n'),
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
        },
      }),
      cache: 'no-store',
      signal,
    },
  );
  if (!response.ok) {
    if (response.status === 429) {
      let retryAfterSeconds = 60;
      let daily = false;
      try {
        const payload = JSON.parse(
          (await boundedResponse(response, 32_768, signal)).toString('utf8'),
        );
        const details = Array.isArray(payload?.error?.details)
          ? payload.error.details
          : [];
        daily = details.some(
          (detail: { violations?: { quotaId?: unknown }[] }) =>
            Array.isArray(detail?.violations) &&
            detail.violations.some(
              (v) =>
                typeof v?.quotaId === 'string' && /PerDay/i.test(v.quotaId),
            ),
        );
        const retry = details.find(
          (detail: { retryDelay?: unknown }) =>
            typeof detail?.retryDelay === 'string' &&
            /^\d+(?:\.\d+)?s$/.test(detail.retryDelay),
        );
        if (retry)
          retryAfterSeconds = Math.max(
            1,
            Math.min(3_600, Math.ceil(parseFloat(retry.retryDelay))),
          );
      } catch {
        /* Never expose the upstream body or credentials in an error. */
      }
      throw new SpeechError(
        daily ? 'daily_limit' : 'rate_limited',
        daily ? dailyQuotaRetrySeconds() : retryAfterSeconds,
      );
    }
    await response.body?.cancel();
    throw new SpeechError('unavailable');
  }
  if (
    response.headers.get('content-type')?.split(';')[0].trim() !==
    'application/json'
  ) {
    await response.body?.cancel();
    throw new SpeechError('unavailable');
  }
  const body = await boundedResponse(
    response,
    Math.ceil((MAX_TTS_AUDIO_BYTES * 4) / 3) + 4096,
    signal,
  );
  const bytes = geminiAudioToWave(JSON.parse(body.toString('utf8')));
  signal.throwIfAborted();
  return { bytes, contentType: 'audio/wav' as const };
}
