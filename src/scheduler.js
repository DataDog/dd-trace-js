'use strict'

// TODO: flush on process exit

class Scheduler {
  constructor (callback, interval) {
    this._timer = null
    this._callback = callback
    this._interval = interval
  }

  start () {
    this._timer = setInterval(this._callback, this._interval)
    this._timer.unref && this._timer.unref()
  }

  stop () {
    clearInterval(this._timer)
  }

  reset () {
    this.stop()
    this.start()
  }
}

module.exports = Scheduler
