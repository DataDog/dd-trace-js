'use strict'

const platform = require('./platform')

class Scheduler {
  constructor (callback, interval) {
    this._timer = null
    this._callback = callback
    this._interval = interval
  }

  start () {
    this._timer = setInterval(this._callback, this._interval)
    this._timer.unref && this._timer.unref()

    platform.on('exit', this._callback)
  }

  stop () {
    clearInterval(this._timer)

    platform.off('exit', this._callback)
  }

  reset () {
    this.stop()
    this.start()
  }
}

module.exports = Scheduler
