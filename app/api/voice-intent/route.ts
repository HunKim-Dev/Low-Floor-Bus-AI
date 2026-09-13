import { interpretVoice } from '@/lib/voice-intent';

export const runtime = 'nodejs';
export const maxDuration = 15;

// Best-effort instance-wide cost guard, not distributed abuse protection.
let windowStart = 0;
let requests = 0;

export async function POST(request: Request) {
  const reply = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  const origin = request.headers.get('origin');
  if (
    (origin && origin !== new URL(request.url).origin) ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  ) {
    return reply({ error: '이 앱에서 다시 요청해 주세요.' }, 403);
  }
  if (!request.headers.get('content-type')?.includes('application/json'))
    return reply({ error: 'JSON 요청이 필요해요.' }, 415);
  let body;
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error('empty body');
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4_096) {
        await reader.cancel();
        throw new Error('too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    body = JSON.parse(text + decoder.decode());
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
  } catch {
    return reply({ error: '말한 내용은 300자 이내로 입력해 주세요.' }, 400);
  }
  if (Date.now() - windowStart > 60_000) {
    windowStart = Date.now();
    requests = 0;
  }
  if (++requests > 30)
    return reply({ error: '요청이 많아요. 잠시 후 다시 말해 주세요.' }, 429);
  try {
    return reply(
      await interpretVoice(body.message.trim(), body.pendingSlot ?? null, {
        apiKey:
          process.env.VOICE_AI_ENABLED === 'true'
            ? process.env.OPENAI_API_KEY
            : undefined,
        model: process.env.OPENAI_VOICE_INTENT_MODEL,
        signal: request.signal,
      }),
    );
  } catch {
    return reply({ error: '요청이 취소됐어요.' }, 408);
  }
}
