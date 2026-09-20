export const MAX_TTS_CHARACTERS = 600;
export const MAX_TTS_AUDIO_BYTES = 2_000_000;
export const TTS_GENERATION_TIMEOUT_MS = 20_000;

// Gemini's daily quota resets at midnight in America/Los_Angeles, not Korea.
// Find the next local date boundary without hard-coding a daylight-saving offset.
export function dailyQuotaRetrySeconds(now = Date.now()) {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = day.format(now);
  let low = now;
  let high = now + 26 * 60 * 60_000;
  while (high - low > 1_000) {
    const mid = Math.floor((low + high) / 2);
    if (day.format(mid) === today) low = mid;
    else high = mid;
  }
  return Math.max(1, Math.ceil((high - now) / 1_000));
}

export function normalizeSpeechText(value: unknown) {
  if (typeof value !== 'string') throw new Error('invalid speech text');
  const text = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (
    !text ||
    text.length > MAX_TTS_CHARACTERS ||
    Array.from(text).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error('invalid speech text');
  return text;
}

export function alertSpeechText(title: string, body: string) {
  return title + '. ' + body;
}
