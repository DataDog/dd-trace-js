'use strict'

// Silence is inferred only between recent provider observations. Unknown samples stay active.
class SpeechActivity {
  #silence = []
  /** @type {number | undefined} */
  #lastOffset = undefined
  /** @type {number | undefined} */
  #lastReceived = undefined
  #speaking = true
  #overflow = false

  /**
   * @param {number} start
   * @param {number} end
   */
  addSilence (start, end) {
    start = Math.max(0, start)
    if (end <= start || this.#overflow) return
    const last = this.#silence.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(end, last[1])
    else if (this.#silence.length < 128) this.#silence.push([start, end])
    else {
      this.#silence = []
      this.#overflow = true
    }
  }

  /**
   * @param {unknown} score
   * @param {number} offset
   * @param {number} now
   */
  observe (score, offset, now) {
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return
    if (this.#lastOffset !== undefined && this.#lastReceived !== undefined) {
      if (offset < this.#lastOffset || now < this.#lastReceived) return
      if (!this.#speaking && now - this.#lastReceived <= 500) {
        this.addSilence(this.#lastOffset, Math.min(offset, this.#lastOffset + 500))
      }
      if (offset - this.#lastOffset > 500 || now - this.#lastReceived > 500) this.#speaking = true
    }
    this.#lastOffset = offset
    this.#lastReceived = now
    if (score >= 0.5) this.#speaking = true
    else if (score <= 0.35) this.#speaking = false
  }

  /** @param {number} duration */
  continueAt (duration) {
    const next = new SpeechActivity()
    if (this.#lastOffset !== undefined && this.#lastReceived !== undefined) {
      next.#lastOffset = this.#lastOffset - duration
      next.#lastReceived = this.#lastReceived
      next.#speaking = this.#speaking
    }
    return next
  }

  /**
   * @param {number} duration
   * @param {number | undefined} lastAudio
   */
  extendSilence (duration, lastAudio) {
    if (!this.#speaking && this.#lastOffset !== undefined && this.#lastReceived !== undefined &&
        lastAudio !== undefined &&
        lastAudio - this.#lastReceived <= 500) {
      this.addSilence(this.#lastOffset, Math.min(duration, this.#lastOffset + 500))
    }
  }

  /**
   * @param {SpeechActivity} other
   * @param {number} duration
   * @param {number | undefined} lastAudio
   */
  extend (other, duration, lastAudio) {
    this.extendSilence(duration, lastAudio)
    for (const [start, end] of other.#silence) this.addSilence(start + duration, end + duration)
    if (other.#lastOffset !== undefined) {
      this.#lastOffset = other.#lastOffset + duration
      this.#lastReceived = other.#lastReceived
      this.#speaking = other.#speaking
    }
    this.#overflow ||= other.#overflow
  }

  /**
   * @param {number} duration
   * @param {number | undefined} lastAudio
   */
  metadata (duration, lastAudio) {
    if (this.#lastOffset === undefined || this.#overflow || duration <= 0) return
    this.extendSilence(duration, lastAudio)
    const intervals = []
    let cursor = 0
    for (const [from, to] of this.#silence) {
      const start = Math.min(duration, from)
      if (start > cursor) intervals.push([Math.floor(cursor), Math.ceil(start)])
      cursor = Math.max(cursor, Math.min(duration, to))
    }
    if (cursor < duration) intervals.push([Math.floor(cursor), Math.ceil(duration)])
    const merged = []
    for (const [start, end] of intervals) {
      const last = merged.at(-1)
      if (last && start <= last[1]) last[1] = Math.max(end, last[1])
      else merged.push([start, end])
    }
    if (merged.length > 128) return
    return { version: 1, source: 'elevenlabs_vad', timing: 'estimated', intervals_ms: merged }
  }
}

module.exports = SpeechActivity
