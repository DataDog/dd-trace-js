'use strict'

class Scheduler {
  constructor (callback, interval) {
    this._timer = null
    this._callback = callback
    this._interval = interval
  }

  start () {
    if (this._timer) return

    this.runAfterDelay(0)
  }

  runAfterDelay (interval = this._interval) {
    this._timer = setTimeout(this._callback, interval, () => this.runAfterDelay())

    this._timer.unref && this._timer.unref()
  }

  stop () {
    clearTimeout(this._timer)

    this._timer = null
  }
}

module.exports = Scheduler
