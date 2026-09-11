'use strict'

// Raw-audio primitives shared by the LLM Observability integrations: mapping provider audio formats
// to MIME types, decoding telephony audio to PCM16, wrapping PCM16 in a WAV container, and deriving
// a segment's playback duration from its byte count. Deliberately free of LLM Observability concepts
// so the realtime instrumentation can use the timing half without pulling in span plumbing.

const { G711_SAMPLE_RATE, PCM16_BYTES_PER_SAMPLE, WAV_HEADER_BYTES } = require('./constants/audio')

// OpenAI Realtime audio `format` values (legacy string form) that don't map to `audio/<format>`.
// A Map rather than an object literal so a hostile format string ("constructor", "__proto__") can't
// resolve to something off Object.prototype.
const REALTIME_FORMAT_MIME_TYPES = new Map([
  ['pcm16', 'audio/pcm'],
  ['pcm', 'audio/pcm'],
  ['g711_ulaw', 'audio/pcmu'],
  ['g711_alaw', 'audio/pcma'],
])

// Raw little-endian PCM16. Not renderable on its own, but losslessly wrappable in a WAV container.
const PCM16_MIME_TYPES = new Set(['audio/pcm', 'audio/pcm16', 'audio/l16'])

// G.711 telephony audio (8 kHz, 8-bit companded), used by Realtime for phone-call integrations.
const G711_MIME_TO_VARIANT = new Map([
  ['audio/pcmu', 'ulaw'],
  ['audio/g711_ulaw', 'ulaw'],
  ['audio/pcma', 'alaw'],
  ['audio/g711_alaw', 'alaw'],
])

/**
 * Decode one G.711 mu-law byte to a signed 16-bit linear PCM sample (CCITT G.711).
 *
 * @param {number} byte
 * @returns {number}
 */
function decodeUlawSample (byte) {
  byte = ~byte & 0xFF
  let sample = ((byte & 0x0F) << 3) + 0x84
  sample <<= (byte & 0x70) >> 4
  return (byte & 0x80) ? (0x84 - sample) : (sample - 0x84)
}

/**
 * Decode one G.711 A-law byte to a signed 16-bit linear PCM sample (CCITT G.711).
 *
 * @param {number} byte
 * @returns {number}
 */
function decodeAlawSample (byte) {
  byte ^= 0x55
  let sample = (byte & 0x0F) << 4
  const segment = (byte & 0x70) >> 4
  if (segment === 0) {
    sample += 8
  } else if (segment === 1) {
    sample += 0x1_08
  } else {
    sample = (sample + 0x1_08) << (segment - 1)
  }
  return (byte & 0x80) ? sample : -sample
}

// The input domain is a single byte, so both decodes collapse to a 256-entry lookup built once.
const ULAW_TABLE = new Int16Array(256)
const ALAW_TABLE = new Int16Array(256)
for (let byte = 0; byte < 256; byte++) {
  ULAW_TABLE[byte] = decodeUlawSample(byte)
  ALAW_TABLE[byte] = decodeAlawSample(byte)
}

/**
 * Map an OpenAI Realtime audio format to a MIME type.
 *
 * Handles both the legacy string form (e.g. "pcm16", "g711_ulaw") and the newer discriminated-union
 * object whose `type` is already a MIME type (e.g. "audio/pcm").
 *
 * @param {string | { type?: string } | undefined} format
 * @returns {string} The MIME type, or an empty string when the format is absent or unusable.
 */
function realtimeAudioFormatToMime (format) {
  const type = typeof format === 'object' && format !== null ? format.type : format
  if (typeof type !== 'string') return ''

  const normalized = type.trim().toLowerCase()
  if (!normalized) return ''
  if (normalized.startsWith('audio/')) return normalized

  return REALTIME_FORMAT_MIME_TYPES.get(normalized) ?? `audio/${normalized}`
}

/**
 * @param {string} mimeType
 * @returns {boolean}
 */
function isPcm16AudioMime (mimeType) {
  return typeof mimeType === 'string' && PCM16_MIME_TYPES.has(mimeType.trim().toLowerCase())
}

/**
 * @param {string} mimeType
 * @returns {'ulaw' | 'alaw' | undefined} The G.711 variant, or `undefined` for any other format.
 */
function g711Variant (mimeType) {
  if (typeof mimeType !== 'string') return
  return G711_MIME_TO_VARIANT.get(mimeType.trim().toLowerCase())
}

/**
 * Decode G.711 audio to raw little-endian PCM16.
 *
 * @param {Buffer} data
 * @param {'ulaw' | 'alaw'} variant
 * @returns {Buffer}
 */
function g711ToPcm16 (data, variant) {
  const table = variant === 'alaw' ? ALAW_TABLE : ULAW_TABLE
  const pcm = Buffer.allocUnsafe(data.length * PCM16_BYTES_PER_SAMPLE)
  for (let i = 0; i < data.length; i++) {
    pcm.writeInt16LE(table[data[i]], i * PCM16_BYTES_PER_SAMPLE)
  }
  return pcm
}

/**
 * Wrap raw little-endian PCM16 audio in a WAV container.
 *
 * Lossless and cheap — it only prepends a 44-byte header — and turns raw PCM, which the UI can't
 * render, into a playable `audio/wav` payload.
 *
 * @param {Buffer} pcm
 * @param {number} [sampleRate]
 * @param {number} [channels]
 * @returns {Buffer}
 */
function pcm16ToWav (pcm, sampleRate = 24_000, channels = 1) {
  const blockAlign = channels * PCM16_BYTES_PER_SAMPLE
  const header = Buffer.allocUnsafe(WAV_HEADER_BYTES)

  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(WAV_HEADER_BYTES - 8 + pcm.length, 4) // RIFF chunk size: everything after this field
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16) // fmt chunk size, 16 for PCM
  header.writeUInt16LE(1, 20) // audio format, 1 for uncompressed PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * blockAlign, 28) // byte rate
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(PCM16_BYTES_PER_SAMPLE * 8, 34) // bits per sample
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(pcm.length, 40)

  return Buffer.concat([header, pcm], WAV_HEADER_BYTES + pcm.length)
}

/**
 * Byte rate of a raw audio format: PCM16 is 2 bytes per sample at the session's rate, G.711 is 1
 * byte per sample at the fixed 8 kHz rate. Any other or unknown format returns `undefined` — we do
 * not guess a rate, so durations and offsets derived from it are simply unavailable.
 *
 * @param {string} mimeType
 * @param {number} sampleRate
 * @returns {number | undefined}
 */
function bytesPerSecond (mimeType, sampleRate) {
  if (sampleRate > 0 && isPcm16AudioMime(mimeType)) return sampleRate * PCM16_BYTES_PER_SAMPLE
  if (g711Variant(mimeType) !== undefined) return G711_SAMPLE_RATE
}

/**
 * Playback duration (in milliseconds) of an audio segment, from its decoded byte count. Sizes the
 * user-speech and agent-speech spans and the turn root's end, so it may be fractional.
 *
 * @param {number} decodedBytes
 * @param {string} mimeType
 * @param {number} sampleRate
 * @returns {number | undefined}
 */
function segmentDurationMs (decodedBytes, mimeType, sampleRate) {
  if (!(decodedBytes > 0)) return
  const rate = bytesPerSecond(mimeType, sampleRate)
  if (!rate) return
  return decodedBytes / rate * 1000
}

module.exports = {
  bytesPerSecond,
  g711ToPcm16,
  g711Variant,
  isPcm16AudioMime,
  pcm16ToWav,
  realtimeAudioFormatToMime,
  segmentDurationMs,
}
