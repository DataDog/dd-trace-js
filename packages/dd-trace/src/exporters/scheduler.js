'use strict'
// TODO: remove this class once system tests are updated
class Scheduler {
  constructor (callback, interval) {
    this._timer = null
    this._callback = callback
    this._interval = interval
  }

  start () {
    this._timer = setInterval(this._callback, this._interval)
    this._timer.unref && this._timer.unref()

    process.once('beforeExit', this._callback)
  }

  stop () {
    clearInterval(this._timer)

    process.removeListener('beforeExit', this._callback)
  }

  reset () {
    this.stop()
    this.start()
  }
}

module.exports = Scheduler
