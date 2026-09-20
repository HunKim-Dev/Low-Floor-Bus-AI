import { interpretCloudflareVoice } from '../../../lib/cloudflare-voice-intent.ts';
import { cloudflareSettings } from '../../../lib/cloudflare-ai.ts';
import {
  assertSameOrigin,
  createRequestGuard,
  InputError,
  privateJson,
  readLimitedBody,
} from '../../../lib/api-input.ts';

export const runtime = 'nodejs';
export const maxDuration = 15;

// Best-effort instance-wide cost guard, not distributed abuse protection.
const guard = createRequestGuard(30);

export async function POST(request: Request) {
  const reply = privateJson;
  try {
    assertSameOrigin(request);
  } catch {
    return reply({ error: '이 앱에서 다시 요청해 주세요.' }, 403);
  }
  if (!request.headers.get('content-type')?.includes('application/json'))
    return reply({ error: 'JSON 요청이 필요해요.' }, 415);
  let body;
  try {
    body = JSON.parse(
      new TextDecoder().decode(await readLimitedBody(request, 4096)),
    );
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof body.message !== 'string' ||
      !body.message.trim() ||
      body.message.length > 300 ||
      ![null, undefined, 'origin', 'destination'].includes(body.pendingSlot)
    )
      throw new Error('invalid body');
  } catch (error) {
    if (error instanceof InputError)
      return reply({ error: error.message }, error.status);
    return reply({ error: '말한 내용은 300자 이내로 입력해 주세요.' }, 400);
  }
  try {
    guard();
    const config = cloudflareSettings();
    return reply(
      await interpretCloudflareVoice(
        body.message.trim(),
        body.pendingSlot ?? null,
        {
          ...(config.intentEnabled ? config : {}),
          model: config.intentModel,
          signal: request.signal,
        },
      ),
    );
  } catch (error) {
    if (error instanceof InputError)
      return reply({ error: error.message }, error.status);
    return reply({ error: '요청이 취소됐어요.' }, 408);
  }
}
