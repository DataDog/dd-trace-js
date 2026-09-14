'use strict'

module.exports = {
  // Surfaced as a message's content when audio was captured but couldn't be turned into a playable
  // part (unsupported format, or over the size budget) and there is no transcript to show instead.
  AUDIO_FALLBACK: '[audio]',

  // G.711 telephony audio is always 8 kHz mono.
  G711_SAMPLE_RATE: 8000,

  // Budget for inline audio, measured on the *base64-encoded* size, since that is what actually
  // rides the span event. Kept below the 5 MB per-span-event limit with headroom for the rest of the
  // event, whose whole I/O is dropped backend-side when oversize. 4 MiB encoded is ~3 MiB of audio.
  LLMOBS_AUDIO_INLINE_MAX_BYTES: 4 * 1024 * 1024,

  // Cap on the raw audio buffered per side of a realtime turn: the point at which base64 encoding
  // would put a 1:1 format over `LLMOBS_AUDIO_INLINE_MAX_BYTES` anyway (4 chars per 3 bytes).
  // Beyond this the size guard would drop the audio at tag time, so we stop retaining it rather
  // than hold megabytes in memory only to discard them. A memory bound, not a correctness one — the
  // guard still decides.
  //
  // A format that expands on the way to a playable part inlines less than this: G.711 decodes to
  // PCM16 at 2 bytes per sample, so only about half of it can ever ride the span event. Callers
  // check the *converted* size against the budget before converting (`fitsInlineAudioBudget`), so
  // the excess is never paid for in allocations — it is only retained and then dropped.
  LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES: 3 * 1024 * 1024,

  PCM16_BYTES_PER_SAMPLE: 2,

  WAV_HEADER_BYTES: 44,
}
