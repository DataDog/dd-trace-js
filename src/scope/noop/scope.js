'use strict'

class Scope {
  constructor (span, finishSpanOnClose) {
    this._span = span
    this._finishSpanOnClose = finishSpanOnClose
  }

  span () {
    return this._span
  }

  close () {
    if (this._finishSpanOnClose) {
      this._span.finish()
    }
  }
}

module.exports = Scope
