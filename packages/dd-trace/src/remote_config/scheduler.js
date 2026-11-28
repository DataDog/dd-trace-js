'use strict'

/** @typedef {(minimumDelayMs?: number) => void} PollDone */

class Scheduler {
  #active = false
  #callback
  #generation = 0
  #inFlight = false
  #interval
  #timer

  /**
   * @param {(done: PollDone) => void} callback
   * @param {number} interval
   */
  constructor (callback, interval) {
    this.#callback = callback
    this.#interval = interval
  }

  start () {
    if (this.#active) return

    this.#active = true
    this.#generation++
    if (!this.#inFlight) this.#runAfterDelay(0)
  }

  /**
   * @param {number} interval
   */
  #runAfterDelay (interval) {
    const generation = this.#generation
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#inFlight = true
      this.#callback(minimumDelayMs => {
        this.#inFlight = false
        if (!this.#active) {
          return
        }

        const delay = minimumDelayMs === undefined ? this.#interval : Math.max(this.#interval, minimumDelayMs)
        this.#runAfterDelay(this.#generation === generation ? delay : 0)
      })
    }, interval)

    this.#timer.unref?.()
  }

  stop () {
    this.#active = false
    clearTimeout(this.#timer)

    this.#timer = undefined
  }
}

module.exports = Scheduler
