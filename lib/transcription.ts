import { Buffer } from 'node:buffer';
import {
  CLOUDFLARE_SPEECH_MODEL,
  runCloudflareModel,
  type CloudflareOptions,
} from './cloudflare-ai.ts';
import { validateMonoWav } from './audio-wav.ts';

export async function transcribeAudio(
  audio: ArrayBuffer,
  options: CloudflareOptions,
) {
  const info = validateMonoWav(audio);
  if (info.silent) return { text: '', reason: 'no_speech' as const };
  const result = (await runCloudflareModel(
    CLOUDFLARE_SPEECH_MODEL,
    {
      audio: Buffer.from(audio).toString('base64'),
      task: 'transcribe',
      language: 'ko',
      vad_filter: true,
      condition_on_previous_text: false,
      initial_prompt:
        '한국어 버스 이동 요청. 출발지, 도착지, 현재 위치, 정류장, 저상버스, 준비 시간, 이동 시간, 여유 시간.',
    },
    options,
    18_000,
  )) as { text?: unknown; segments?: { no_speech_prob?: number }[] };
  if (typeof result?.text !== 'string')
    throw new Error('invalid transcription response');
  const text = result.text.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (
    !text ||
    (result.segments?.length &&
      result.segments.every((segment) => (segment.no_speech_prob ?? 0) > 0.85))
  )
    return { text: '', reason: 'no_speech' as const };
  if (text.length > 300) return { text: '', reason: 'too_long' as const };
  return { text, reason: null };
}
