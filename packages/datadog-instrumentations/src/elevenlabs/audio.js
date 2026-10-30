'use strict'

const { LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES } = require('../../../dd-trace/src/llmobs/constants/audio')
const SpeechActivity = require('./activity')

// Leave space for both WAV headers before spending the shared encoded event budget.
const RAW_LIMIT = LLMOBS_AUDIO_ACCUMULATE_MAX_BYTES - 128
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

class AudioBuffer {
  chunks = []
  size = 0
  total = 0
  /** @type {number | undefined} */
  start = undefined
  /** @type {number | undefined} */
  lastAudio = undefined
  overflow = false
  present = false
  activity = new SpeechActivity()

  /**
   * @param {unknown} encoded
   * @param {number} now
   * @param {number} rate
   * @param {boolean} input
   * @param {boolean} retain
   */
  append (encoded, now, rate, input, retain) {
    this.present = true
    if (!rate || typeof encoded !== 'string' || !encoded.length) return
    // Bound before validating/decoding an attacker-controlled string.
    if (encoded.length > Math.ceil(RAW_LIMIT / 3) * 4) {
      this.omit()
      return
    }
    if (!BASE64.test(encoded)) return
    const size = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0)
    if (size % 2) return
    this.start ??= input ? now - size / (2 * rate) * 1000 : now
    this.total += size
    this.lastAudio = now
    if (!retain) {
      this.omit()
      return
    }
    if (this.overflow || this.size + size > RAW_LIMIT) this.omit()
    else {
      if (this.chunks.length >= 1024) this.chunks = [this.bytes()]
      this.chunks.push(Buffer.from(encoded, 'base64'))
      this.size += size
    }
  }

  omit () {
    this.chunks = []
    this.size = 0
    this.overflow = true
  }

  /** @param {number} rate */
  duration (rate) { return rate ? this.total / (2 * rate) * 1000 : 0 }

  /** @param {number} rate */
  end (rate) { return this.start === undefined ? undefined : this.start + this.duration(rate) }

  /**
   * @param {number} now
   * @param {number} rate
   */
  trim (now, rate) {
    if (this.start === undefined || !rate) return
    const size = Math.max(0, Math.floor((now - this.start) * rate / 1000)) * 2
    this.total = Math.min(this.total, size)
    if (!this.overflow && this.size > size) {
      this.chunks = [this.bytes().subarray(0, size)]
      this.size = size
    }
  }

  /**
   * @param {AudioBuffer} other
   * @param {number} rate
   */
  extend (other, rate) {
    this.activity.extend(other.activity, this.duration(rate), this.lastAudio)
    this.start ??= other.start
    this.total += other.total
    this.lastAudio = other.lastAudio ?? this.lastAudio
    this.present ||= other.present
    if (this.overflow || other.overflow || this.size + other.size > RAW_LIMIT) this.omit()
    else {
      this.chunks.push(...other.chunks)
      this.size += other.size
    }
  }

  bytes () { return Buffer.concat(this.chunks, this.size) }
}

module.exports = { AudioBuffer, RAW_LIMIT }
