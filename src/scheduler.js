'use strict'

// TODO: flush on process exit

class Scheduler {
  constructor (callback, delay) {
    this._timer = null
    this._callback = callback
    this._delay = delay
  }

  start () {
    this._timer = setInterval(this._callback, this._delay)
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
