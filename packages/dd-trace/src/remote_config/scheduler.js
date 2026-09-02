'use strict'

class Scheduler {
  #active = false
  #callback
  #generation = 0
  #inFlight = false
  #interval
  #timer

  /**
   * @param {(done: () => void) => void} callback
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
      this.#callback(() => {
        this.#inFlight = false
        if (!this.#active) return

        this.#runAfterDelay(this.#generation === generation ? this.#interval : 0)
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
