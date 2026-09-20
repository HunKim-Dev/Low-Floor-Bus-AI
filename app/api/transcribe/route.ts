import {
  cloudflareSettings,
  CloudflareError,
} from '../../../lib/cloudflare-ai.ts';
import { transcribeAudio } from '../../../lib/transcription.ts';
import { MAX_AUDIO_BYTES, validateMonoWav } from '../../../lib/audio-wav.ts';
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

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const config = cloudflareSettings();
    if (!config.speechEnabled)
      return privateJson(
        {
          code: 'not_configured',
          error: '음성 받아쓰기가 아직 연결되지 않았어요. 글로 입력해 주세요.',
        },
        503,
      );
    if (
      request.headers.get('content-type')?.split(';')[0].trim() !== 'audio/wav'
    )
      throw new InputError(
        415,
        '지원하지 않는 녹음 형식이에요. 다시 말해 주세요.',
      );
    const audio = await readLimitedBody(request, MAX_AUDIO_BYTES);
    try {
      validateMonoWav(audio);
    } catch {
      throw new InputError(
        400,
        '녹음이 너무 짧거나 올바르지 않아요. 다시 말해 주세요.',
      );
    }
    guard();
    const result = await transcribeAudio(audio, {
      ...config,
      signal: request.signal,
    });
    return privateJson({ ...result, mode: 'cloudflare' });
  } catch (error) {
    if (request.signal.aborted)
      return privateJson(
        { code: 'cancelled', error: '요청을 취소했어요.' },
        408,
      );
    if (error instanceof InputError)
      return privateJson(
        { code: 'invalid_request', error: error.message },
        error.status,
      );
    if (error instanceof CloudflareError && error.code === 'rate_limited')
      return privateJson(
        {
          code: 'rate_limited',
          error:
            '음성 요청이 많아요. 잠시 후 다시 말하거나 글로 입력해 주세요.',
        },
        429,
      );
    return privateJson(
      {
        code: 'unavailable',
        error: '음성을 받아쓰지 못했어요. 다시 말하거나 글로 입력해 주세요.',
      },
      503,
    );
  }
}
