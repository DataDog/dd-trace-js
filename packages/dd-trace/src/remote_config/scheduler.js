'use strict'

class Scheduler {
  #timer = null
  #callback
  #interval

  constructor (callback, interval) {
    this.#callback = callback
    this.#interval = interval
  }

  start () {
    if (this.#timer) return

    this.runAfterDelay(0)
  }

  runAfterDelay (interval = this.#interval) {
    this.#timer = setTimeout(this.#callback, interval, () => this.runAfterDelay())

    this.#timer.unref()
  }

  stop () {
    clearTimeout(this.#timer)

    this.#timer = null
  }
}

module.exports = Scheduler
