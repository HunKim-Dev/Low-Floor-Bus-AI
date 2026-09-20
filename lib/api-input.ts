export class InputError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (
    (origin && origin !== new URL(request.url).origin) ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    throw new InputError(403, '이 앱에서 다시 요청해 주세요.');
}

export async function readLimitedBody(
  request: Request,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const announced = Number(request.headers.get('content-length'));
  if (announced > maxBytes)
    throw new InputError(413, '요청이 너무 커요. 짧게 다시 말해 주세요.');
  const reader = request.body?.getReader();
  if (!reader) throw new InputError(400, '내용이 비어 있어요.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw new InputError(413, '요청이 너무 커요. 짧게 다시 말해 주세요.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer.buffer;
}

// Best effort per-instance guard. A distributed limit belongs at the hosting
// firewall/shared store before a high-traffic public launch.
export function createRequestGuard(limit: number) {
  let windowStart = 0;
  let requests = 0;
  return () => {
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (++requests > limit)
      throw new InputError(429, '요청이 많아요. 잠시 후 다시 말해 주세요.');
  };
}

export function privateJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
