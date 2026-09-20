import { createHash } from 'node:crypto';
import {
  geminiSpeechSettings,
  SpeechError,
  synthesizeSpeech,
  GEMINI_TTS_MODEL,
} from '../../../lib/text-to-speech.ts';
import { normalizeSpeechText } from '../../../lib/speech-text.ts';
import { createSpeechCache } from '../../../lib/speech-cache.ts';
import {
  assertSameOrigin,
  createRequestGuard,
  InputError,
  privateJson,
  readLimitedBody,
} from '../../../lib/api-input.ts';

export const runtime = 'nodejs';
export const maxDuration = 25;
const guard = createRequestGuard(30);
const audioCache = createSpeechCache();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    request.signal.throwIfAborted();
    if (
      request.headers.get('content-type')?.split(';')[0].trim() !==
      'application/json'
    )
      throw new InputError(415, 'JSON 요청이 필요해요.');
    let text: string;
    try {
      const body = JSON.parse(
        new TextDecoder().decode(await readLimitedBody(request, 4096)),
      );
      if (
        !body ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== 'text')
      )
        throw new Error('invalid fields');
      text = normalizeSpeechText(body.text);
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError(400, '안내 문장은 600자 이내로 입력해 주세요.');
    }
    const config = geminiSpeechSettings();
    if (!config.enabled)
      return privateJson(
        {
          code: 'not_configured',
          error:
            'Gemini 음성이 연결되지 않았어요. 화면의 안내를 확인해 주세요.',
        },
        503,
      );
    const key = createHash('sha256')
      .update(
        JSON.stringify([config.apiKey, GEMINI_TTS_MODEL, config.voice, text]),
      )
      .digest('hex');
    let bytes = audioCache.get(key);
    if (!bytes) {
      guard();
      const audio = await synthesizeSpeech(text, {
        ...config,
        signal: request.signal,
      });
      request.signal.throwIfAborted();
      bytes = audio.bytes;
      audioCache.set(key, bytes);
    }
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-TTS-Provider': 'gemini',
      },
    });
  } catch (error) {
    if (request.signal.aborted)
      return privateJson(
        { code: 'cancelled', error: '음성 생성을 취소했어요.' },
        408,
      );
    if (error instanceof InputError && error.status !== 429)
      return privateJson(
        { code: 'invalid_request', error: error.message },
        error.status,
      );
    const daily = error instanceof SpeechError && error.code === 'daily_limit';
    const limited =
      daily ||
      (error instanceof SpeechError && error.code === 'rate_limited') ||
      (error instanceof InputError && error.status === 429);
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    const response = privateJson(
      {
        code: daily
          ? 'daily_limit'
          : limited
            ? 'rate_limited'
            : timedOut
              ? 'timed_out'
              : 'unavailable',
        error: daily
          ? 'Gemini 음성의 오늘 사용 한도를 모두 사용했어요. 한도 초기화 후 다시 이용해 주세요.'
          : limited
            ? 'Gemini 음성 요청이 잠시 몰렸어요. 잠시 후 다시 들어 주세요.'
            : timedOut
              ? '음성 생성이 오래 걸려 중단했어요. 잠시 후 다시 들어 주세요.'
              : 'Gemini 음성을 만들지 못했어요. 잠시 후 다시 들어 주세요.',
      },
      limited ? 429 : timedOut ? 504 : 503,
    );
    if (limited)
      response.headers.set(
        'Retry-After',
        String(
          error instanceof SpeechError ? (error.retryAfterSeconds ?? 60) : 60,
        ),
      );
    return response;
  }
}
