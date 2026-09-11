'use strict'

const {
  LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES,
} = require('../../../dd-trace/src/llmobs/constants/audio')

/**
 * Collects one side of a realtime turn's audio, decoding each base64 frame to a `Buffer` as it
 * arrives.
 *
 * Decoding eagerly rather than retaining base64 costs 1x memory instead of 1.33x, and — because the
 * segment is then just bytes — lets `trimLeading` and `capTo` cut at an exact byte offset with a
 * `subarray`, where operating on base64 would have to decode and re-encode the straddling frame.
 *
 * `present` records that audio was seen at all, so a turn can still surface an `[audio]` marker when
 * the bytes were dropped; `oversize` marks that the retention cap was hit.
 */
class AudioAccumulator {
  /** @type {Buffer[]} */
  chunks = []

  present = false

  oversize = false

  /**
   * Wall clock (epoch ms) when the first frame of this segment was observed, anchoring it on the
   * session timeline. Set even when the bytes are later dropped, since `present` still surfaces a
   * marker.
   *
   * @type {number | undefined}
   */
  startTime = undefined

  /**
   * The audio format in force when this segment's first frame arrived. A segment keeps the format it
   * was captured under, so a later `session.update` cannot retime bytes that arrived before it.
   *
   * @type {string}
   */
  mimeType = ''

  /** @type {number} */
  sampleRate = 0

  /**
   * Total bytes seen for this segment, never reduced by the retention cap. Playback duration — and
   * therefore the speaking window — is derived from this, so it stays accurate even when `chunks`
   * was dropped.
   */
  totalDecodedBytes = 0

  /** Bytes currently retained across `chunks`. */
  #retainedBytes = 0

  /**
   * @param {string} base64
   * @param {number} now - Epoch ms at which this frame was observed.
   * @param {string} [mimeType] - The session's audio format, recorded on the first frame only.
   * @param {number} [sampleRate]
   * @returns {number} Decoded byte count of this frame, for advancing the input-buffer clock.
   */
  append (base64, now, mimeType = '', sampleRate = 0) {
    if (typeof base64 !== 'string' || base64.length === 0) return 0

    if (this.startTime === undefined) {
      this.startTime = now
      this.mimeType = mimeType
      this.sampleRate = sampleRate
    }
    this.present = true

    const decoded = Buffer.from(base64, 'base64')
    this.totalDecodedBytes += decoded.length

    if (this.oversize) return decoded.length

    this.#retainedBytes += decoded.length
    if (this.#retainedBytes > LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES) {
      // Free what we had: the size guard would drop the whole segment anyway.
      this.oversize = true
      this.chunks = []
      return decoded.length
    }

    this.chunks.push(decoded)
    return decoded.length
  }

  /**
   * Drop this segment's first `decodedBytes` bytes.
   *
   * Cuts the pre-speech audio a continuously-streaming client appends — the microphone keeps sending
   * while the agent talks — off the front of a user turn, so the captured audio covers the same
   * window the span reports.
   *
   * @param {number} decodedBytes
   * @returns {void}
   */
  trimLeading (decodedBytes) {
    if (!(decodedBytes > 0)) return

    if (decodedBytes >= this.totalDecodedBytes) {
      // Everything seen so far precedes the onset, so the segment starts empty. Reset outright,
      // retention cap included: otherwise a long silent lead-in — the buffer stays open across the
      // whole previous agent response — could spend the cap before the speech even starts and leave
      // the turn with nothing but an `[audio]` marker.
      this.clear()
      return
    }

    let remaining = decodedBytes
    while (this.chunks.length > 0 && remaining > 0) {
      const chunk = this.chunks[0]
      if (chunk.length > remaining) {
        this.chunks[0] = chunk.subarray(remaining)
        break
      }
      this.chunks.shift()
      remaining -= chunk.length
    }

    // Re-derive the cap from what actually survived, which also reopens a segment the lead-in had
    // closed. On a continuously-streaming client the lead-in is what spends the cap — the buffer
    // stays open across the whole previous agent response — and `append` drops the frames when it
    // trips, so without this the cap the trimmed-away audio filled would go on rejecting the user's
    // actual speech for the rest of the turn. That is the outcome trimming exists to prevent.
    this.#retainedBytes = 0
    for (const chunk of this.chunks) this.#retainedBytes += chunk.length
    this.oversize = this.#retainedBytes > LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES

    this.totalDecodedBytes = Math.max(0, this.totalDecodedBytes - decodedBytes)
  }

  /**
   * Shrink this segment to its first `decodedBytes` bytes.
   *
   * The mirror of `trimLeading`, for audio that was delivered but never heard: when the listener cuts
   * the agent off, everything past that point is generated-but-unplayed. Absolute and shrink-only, so
   * a client truncation and the server's acknowledgement of it apply the cap once between them.
   *
   * @param {number} decodedBytes
   * @returns {void}
   */
  capTo (decodedBytes) {
    if (decodedBytes >= this.totalDecodedBytes) return

    if (decodedBytes <= 0) {
      // Nothing was heard at all, so the segment is empty rather than zero-length-but-present.
      this.clear()
      return
    }

    let kept = 0
    const chunks = []
    for (const chunk of this.chunks) {
      if (kept + chunk.length <= decodedBytes) {
        chunks.push(chunk)
        kept += chunk.length
        continue
      }
      const partial = chunk.subarray(0, decodedBytes - kept)
      if (partial.length > 0) {
        chunks.push(partial)
        kept += partial.length
      }
      break
    }

    this.chunks = chunks
    this.#retainedBytes = kept
    this.totalDecodedBytes = decodedBytes
  }

  /**
   * The retained audio as one buffer. Empty when the segment was dropped or never had bytes.
   *
   * @returns {Buffer}
   */
  toBuffer () {
    return this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.#retainedBytes)
  }

  /** @returns {void} */
  clear () {
    this.chunks = []
    this.present = false
    this.oversize = false
    this.startTime = undefined
    this.mimeType = ''
    this.sampleRate = 0
    this.totalDecodedBytes = 0
    this.#retainedBytes = 0
  }
}

module.exports = AudioAccumulator
