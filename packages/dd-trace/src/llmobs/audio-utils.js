'use strict'

// Building `audioPart`s for LLM Observability messages: mapping provider audio formats to MIME
// types, and keeping inline audio within the per-span-event size budget. The raw-audio primitives
// these build on (WAV wrapping, G.711 decoding, byte rates) live in `audio-codec.js`.

const log = require('../log')
const { LLMOBS_AUDIO_INLINE_MAX_BYTES } = require('./constants/audio')

/**
 * @typedef {{ mimeType: string, content: string }} AudioPart
 */

// Raw audio formats the UI cannot render as a player. For these we keep the transcript as the
// message content and skip the inline audio part, since raw bytes would only bloat the payload.
const NON_RENDERABLE_AUDIO_MIME_TYPES = new Set([
  'audio/pcm',
  'audio/pcm16',
  'audio/l16',
  'audio/pcmu',
  'audio/pcma',
  'audio/g711_ulaw',
  'audio/g711_alaw',
  'audio/basic',
])

/**
 * Length of `byteLength` bytes after standard base64 encoding: 4 characters per 3 bytes, padded.
 *
 * @param {number} byteLength
 * @returns {number}
 */
function base64EncodedLength (byteLength) {
  return Math.ceil(byteLength / 3) * 4
}

// Maps an audio `format` (e.g. "wav", "mp3") to a MIME type. Defaults to `audio/wav` when the
// format is missing. Provider-specific overrides (e.g. OpenAI's mp3 -> audio/mpeg) are passed in
// via `mimeTypeLookup` so this stays provider-agnostic. A non-string `format` is treated as missing
// so a malformed auto-instrumented payload can't throw and disable the plugin.
/**
 * @param {string} fmt
 * @param {Record<string, string>} [mimeTypeLookup]
 * @returns {string}
 */
function audioMimeTypeFromFormat (fmt, mimeTypeLookup = {}) {
  fmt = typeof fmt === 'string' ? fmt.trim().toLowerCase() : ''
  if (!fmt) return 'audio/wav'
  // `hasOwn` rather than a plain lookup: a format of "constructor" would otherwise resolve to
  // something off Object.prototype and be returned as the MIME type.
  return Object.hasOwn(mimeTypeLookup, fmt) ? mimeTypeLookup[fmt] : `audio/${fmt}`
}

/**
 * Whether a MIME type can be rendered as an audio player in the UI. Raw PCM cannot.
 *
 * @param {string} mimeType
 * @returns {boolean}
 */
function isRenderableAudioMime (mimeType) {
  return typeof mimeType === 'string' &&
    mimeType.length > 0 &&
    !NON_RENDERABLE_AUDIO_MIME_TYPES.has(mimeType.trim().toLowerCase())
}

// Builds an audio part from raw audio bytes (base64-encoded) or an existing base64 string. Only
// Buffer/Uint8Array inputs are base64-encoded; any other shape is passed through so a malformed
// auto-instrumented payload can't throw (the tagger soft-skips a non-string `content`).
/**
 * @param {Buffer | Uint8Array | string} data
 * @param {string} mimeType
 * @returns {AudioPart}
 */
function formatAudioPart (data, mimeType) {
  const content = Buffer.isBuffer(data) || ArrayBuffer.isView(data)
    ? Buffer.from(data).toString('base64')
    : data
  return { mimeType, content }
}

/**
 * Build a playable audio part, but only for renderable formats within the size budget. Returns
 * `undefined` for a non-renderable format (e.g. raw PCM) or oversize audio; callers fall back to the
 * transcript as the message content in that case.
 *
 * @param {Buffer} audioBytes
 * @param {string} mimeType
 * @param {number} [maxBytes]
 * @returns {AudioPart | undefined}
 */
function formatAudioPartWithGuard (audioBytes, mimeType, maxBytes = LLMOBS_AUDIO_INLINE_MAX_BYTES) {
  if (!audioBytes?.length || !isRenderableAudioMime(mimeType)) return

  // Compare the *encoded* size: `formatAudioPart` base64-encodes the bytes (~4/3 expansion), and it
  // is that encoded content which counts against the per-span-event limit.
  const encodedLength = base64EncodedLength(audioBytes.length)
  if (encodedLength > maxBytes) {
    log.debug('Audio (%d encoded bytes) exceeds inline budget %d; omitting inline audio content',
      encodedLength, maxBytes)
    return
  }

  return formatAudioPart(audioBytes, mimeType)
}

module.exports = {
  audioMimeTypeFromFormat,
  formatAudioPart,
  formatAudioPartWithGuard,
  isRenderableAudioMime,
}
