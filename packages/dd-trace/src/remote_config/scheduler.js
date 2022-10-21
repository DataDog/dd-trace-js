'use strict'

class Scheduler {
  constructor (callback, interval) {
    this._timer = null
    this._callback = callback
    this._interval = interval
    this._running = false
  }

  func () {
    if (this._running) return
    this._running = true

    this._callback(() => {
      this._running = false
    })
  }

  start () {
    if (this._timer) return

    const cb = () => this.func()

    setImmediate(cb)

    this._timer = setInterval(cb, this._interval)

    this._timer.unref && this._timer.unref()
  }

  stop () {
    clearInterval(this._timer)

    this._timer = null
  }
}

module.exports = Scheduler
