export const AUDIO_SAMPLE_RATE = 16_000;
export const MAX_RECORDING_SECONDS = 15;
export const MAX_AUDIO_BYTES =
  44 + AUDIO_SAMPLE_RATE * 2 * MAX_RECORDING_SECONDS;

export function encodeMonoWav(samples: Float32Array): ArrayBuffer {
  const length = Math.min(
    samples.length,
    AUDIO_SAMPLE_RATE * MAX_RECORDING_SECONDS,
  );
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, AUDIO_SAMPLE_RATE, true);
  view.setUint32(28, AUDIO_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const sample = Math.max(
      -1,
      Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0),
    );
    view.setInt16(
      44 + i * 2,
      Math.round(sample * (sample < 0 ? 32768 : 32767)),
      true,
    );
  }
  return buffer;
}

// Accept only our canonical PCM format, so duration is verified from actual
// sample count rather than a client-supplied duration/MIME header.
export function validateMonoWav(buffer: ArrayBuffer) {
  if (buffer.byteLength < 44 || buffer.byteLength > MAX_AUDIO_BYTES)
    throw new Error('invalid audio size');
  const view = new DataView(buffer);
  const text = (offset: number, size: number) =>
    String.fromCharCode(...new Uint8Array(buffer, offset, size));
  const bytes = buffer.byteLength - 44;
  if (
    text(0, 4) !== 'RIFF' ||
    text(8, 4) !== 'WAVE' ||
    text(12, 4) !== 'fmt ' ||
    text(36, 4) !== 'data' ||
    view.getUint32(4, true) !== buffer.byteLength - 8 ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint32(24, true) !== AUDIO_SAMPLE_RATE ||
    view.getUint32(28, true) !== AUDIO_SAMPLE_RATE * 2 ||
    view.getUint16(32, true) !== 2 ||
    view.getUint16(34, true) !== 16 ||
    view.getUint32(40, true) !== bytes ||
    bytes % 2 !== 0 ||
    bytes < AUDIO_SAMPLE_RATE * 2 * 0.25
  )
    throw new Error('invalid audio format');
  let energy = 0;
  for (let i = 44; i < buffer.byteLength; i += 2)
    energy += (view.getInt16(i, true) / 32768) ** 2;
  return {
    durationSeconds: bytes / (AUDIO_SAMPLE_RATE * 2),
    silent: Math.sqrt(energy / (bytes / 2)) < 0.001,
  };
}
