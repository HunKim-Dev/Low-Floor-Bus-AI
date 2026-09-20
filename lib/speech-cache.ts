import { MAX_TTS_AUDIO_BYTES } from './speech-text.ts';

// Ephemeral per-instance cache only: no files, shared HTTP cache or persistent
// storage of personal route audio. Keys are opaque hashes made on the server.
export function createSpeechCache(now = Date.now) {
  const entries = new Map<string, { bytes: Uint8Array; expires: number }>();
  return {
    get(key: string) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expires <= now()) {
        entries.delete(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.bytes;
    },
    set(key: string, bytes: Uint8Array) {
      if (!bytes.length || bytes.length > MAX_TTS_AUDIO_BYTES) return;
      for (const [id, entry] of entries)
        if (entry.expires <= now()) entries.delete(id);
      entries.delete(key);
      entries.set(key, { bytes, expires: now() + 5 * 60_000 });
      while (
        entries.size > 8 ||
        [...entries.values()].reduce(
          (sum, entry) => sum + entry.bytes.length,
          0,
        ) > 8_000_000
      )
        entries.delete(entries.keys().next().value!);
    },
  };
}
