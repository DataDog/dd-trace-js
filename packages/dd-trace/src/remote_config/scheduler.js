'use strict'

class Scheduler {
  #timer = null

  constructor (callback, interval) {
    this._callback = callback
    this._interval = interval
  }

  start () {
    if (this.#timer) return

    this.runAfterDelay(0)
  }

  runAfterDelay (interval = this._interval) {
    this.#timer = setTimeout(this._callback, interval, () => this.runAfterDelay())

    this.#timer.unref()
  }

  stop () {
    clearTimeout(this.#timer)

    this.#timer = null
  }
}

module.exports = Scheduler
