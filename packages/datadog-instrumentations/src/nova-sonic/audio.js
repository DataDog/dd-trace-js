'use strict'

const { LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES } = require('../../../dd-trace/src/llmobs/constants/audio')

// Leave room for the WAV header when the retained PCM is encoded.
const MAX_AUDIO = LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES - 128
const RATES = new Set([8000, 16_000, 24_000, 48_000])
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** @param {object} configuration */
function pcmRate (configuration = {}) {
  return configuration.mediaType === 'audio/lpcm' && configuration.sampleSizeBits === 16 &&
    configuration.channelCount === 1 && configuration.encoding === 'base64' &&
    RATES.has(configuration.sampleRateHertz)
    ? configuration.sampleRateHertz
    : 0
}

/** @param {string} encoded */
function decode (encoded) {
  if (typeof encoded !== 'string' || encoded.length % 4 || !BASE64.test(encoded)) return
  return Buffer.from(encoded, 'base64')
}

/** A bounded, connection-wide sample timeline. Content-name changes do not reset its origin. */
class InputAudio {
  rate = 0
  valid = true
  total = 0
  anchor
  #chunks = []
  #bytes = 0

  /** @param {object} configuration */
  configure (configuration) {
    const rate = pcmRate(configuration)
    if (!rate || (this.total && rate !== this.rate)) this.valid = false
    this.rate = rate
  }

  /**
   * @param {string} encoded
   * @param {number} now Milliseconds at SDK consumption, not an acknowledgement from the provider.
   */
  append (encoded, now) {
    const raw = decode(encoded)
    if (!raw) {
      this.valid = false
      this.clear()
      return
    }
    if (raw.length % 2) this.valid = false
    this.total += raw.length
    if (this.rate) this.anchor = now - this.total * 1000 / (2 * this.rate)
    if (!this.valid || !raw.length) return
    // Copy large tails so the ring cannot retain a much larger backing allocation.
    const retained = raw.length > MAX_AUDIO ? Buffer.from(raw.subarray(-MAX_AUDIO)) : raw
    this.#chunks.push(retained)
    this.#bytes += retained.length
    while (this.#bytes > MAX_AUDIO) {
      const first = this.#chunks[0]
      const excess = this.#bytes - MAX_AUDIO
      if (first.length <= excess) {
        this.#chunks.shift()
        this.#bytes -= first.length
      } else {
        this.#chunks[0] = Buffer.from(first.subarray(excess))
        this.#bytes -= excess
      }
    }
  }

  /**
   * @param {number} startMs
   * @param {number} endMs
   */
  clip (startMs, endMs) {
    if (!this.valid || !this.rate || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return
    const start = Math.floor(startMs * this.rate / 1000) * 2
    const end = Math.floor(endMs * this.rate / 1000) * 2
    const base = this.total - this.#bytes
    if (start < base || end > this.total) return
    return Buffer.from(Buffer.concat(this.#chunks, this.#bytes).subarray(start - base, end - base))
  }

  clear () {
    this.#chunks = []
    this.#bytes = 0
  }
}

/** Ordered PCM playback projection for one response, including genuine underrun silence. */
class OutputAudio {
  rate = 0
  start
  end
  interrupted
  generatedBytes = 0
  timingValid = true
  omittedReason
  #chunks = []
  #bytes = 0

  /**
   * @param {string} encoded
   * @param {object} configuration
   * @param {number} now
   */
  append (encoded, configuration, now) {
    const raw = decode(encoded)
    if (raw) this.generatedBytes += raw.length
    // Late chunks cannot resurrect playback or invalidate the clip already cut at interruption.
    if (this.interrupted !== undefined) return
    const rate = pcmRate(configuration)
    if (!raw || !rate || raw.length % 2 || (this.rate && this.rate !== rate)) {
      this.timingValid = false
      this.omittedReason = 'invalid_audio'
      this.#chunks = []
      this.#bytes = 0
      return
    }
    if (!raw.length) return
    this.rate ||= rate
    this.start ??= now
    const previousEnd = this.end ?? now
    const gap = Math.floor(Math.max(0, now - previousEnd) * rate / 1000) * 2
    this.end = previousEnd + (gap + raw.length) * 1000 / (2 * rate)
    if (!this.omittedReason && this.#bytes + gap + raw.length <= MAX_AUDIO) {
      if (gap) this.#chunks.push(Buffer.alloc(gap))
      this.#chunks.push(raw)
      this.#bytes += gap + raw.length
    } else {
      this.omittedReason ||= 'retention_limit'
      this.#chunks = []
      this.#bytes = 0
    }
  }

  /** @param {number} now */
  interrupt (now) {
    if (this.interrupted !== undefined) return
    this.interrupted = now
    if (this.start === undefined || this.end === undefined || !this.rate) return
    const frames = Math.floor(Math.max(0, now - this.start) * this.rate / 1000)
    this.end = Math.min(this.end, this.start + frames * 1000 / this.rate)
    if (this.#bytes > frames * 2) {
      const clip = Buffer.concat(this.#chunks, this.#bytes).subarray(0, frames * 2)
      this.#chunks = [Buffer.from(clip)]
      this.#bytes = clip.length
    }
  }

  pcm () {
    if (!this.omittedReason && this.#bytes) return Buffer.concat(this.#chunks, this.#bytes)
  }
}

module.exports = { InputAudio, OutputAudio }
