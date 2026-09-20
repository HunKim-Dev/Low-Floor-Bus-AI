// Server-side adapter. Never import this module from a client component.
export const CLOUDFLARE_INTENT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
export const CLOUDFLARE_SPEECH_MODEL = '@cf/openai/whisper-large-v3-turbo';

export type CloudflareOptions = {
  accountId?: string;
  apiToken?: string;
  model?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
};

export class CloudflareError extends Error {
  code:
    | 'not_configured'
    | 'configuration_error'
    | 'rate_limited'
    | 'unavailable';
  constructor(code: CloudflareError['code']) {
    super(code);
    this.code = code;
  }
}

export function cloudflareConfiguration(options: CloudflareOptions) {
  if (!options.accountId?.trim() || !options.apiToken?.trim())
    return 'not_configured';
  if (!/^[a-f\d]{32}$/i.test(options.accountId.trim()))
    return 'configuration_error';
  return 'ready';
}

export function cloudflareSettings(env: NodeJS.ProcessEnv = process.env) {
  const credentials = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID?.trim(),
    apiToken: env.CLOUDFLARE_API_TOKEN?.trim(),
  };
  const ready = cloudflareConfiguration(credentials) === 'ready';
  return {
    ...credentials,
    intentEnabled: env.VOICE_AI_ENABLED !== 'false' && ready,
    speechEnabled: env.VOICE_TRANSCRIPTION_ENABLED !== 'false' && ready,
    intentModel: env.CLOUDFLARE_VOICE_INTENT_MODEL || CLOUDFLARE_INTENT_MODEL,
  };
}

export async function runCloudflareModel(
  model: string,
  input: Record<string, unknown>,
  options: CloudflareOptions,
  timeoutMs = 8_000,
): Promise<unknown> {
  const configuration = cloudflareConfiguration(options);
  if (configuration !== 'ready') throw new CloudflareError(configuration);
  if (!/^@(cf|hf)\/[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(model))
    throw new CloudflareError('configuration_error');
  const response = await (options.fetcher ?? fetch)(
    `https://api.cloudflare.com/client/v4/accounts/${options.accountId!.trim()}/ai/run/${model}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiToken!.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
      cache: 'no-store',
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok)
    throw new CloudflareError(
      response.status === 429 ? 'rate_limited' : 'unavailable',
    );
  const payload = await response.json();
  if (payload?.success !== true || !payload.result)
    throw new CloudflareError('unavailable');
  return payload.result;
}

// Qwen's run endpoint returns a chat completion; other JSON-mode models
// return { response: object | string }. Do not treat reasoning as the answer.
export function cloudflareStructuredOutput(value: unknown): unknown {
  if (!value || typeof value !== 'object')
    throw new Error('invalid model response');
  const result = value as {
    response?: unknown;
    choices?: {
      finish_reason?: string;
      message?: { content?: unknown; refusal?: unknown };
    }[];
  };
  let content = result.response;
  if (Array.isArray(result.choices)) {
    const choice = result.choices[0];
    if (
      result.choices.length !== 1 ||
      choice?.finish_reason !== 'stop' ||
      choice.message?.refusal
    )
      throw new Error('incomplete model response');
    content = choice.message?.content;
  }
  if (typeof content === 'string') return JSON.parse(content);
  if (content && typeof content === 'object' && !Array.isArray(content))
    return content;
  throw new Error('missing structured response');
}
