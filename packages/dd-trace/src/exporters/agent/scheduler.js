'use strict'

const config = require('../../config')
const platform = require('../../platform')

class Scheduler {
  constructor (callback) {
    this._timer = null
    this._callback = callback
  }

  start () {
    config.retroOn('update', ({ flushInterval }) => {
      if (this._timer) {
        clearInterval(this._timer)
      }
      this._timer = setInterval(this._callback, flushInterval)
      this._timer.unref && this._timer.unref()
    })

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
