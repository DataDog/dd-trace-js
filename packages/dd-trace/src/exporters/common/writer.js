'use strict'
class Writer {
  constructor ({ url }) {
    this._url = url
  }

  flush (done = () => {}) {
    const count = this._encoder.count()

    if (count > 0) {
      const payload = this._encoder.makePayload()

      this._sendPayload(payload, count, done)
    } else {
      done()
    }
  }

  setUrl (url) {
    this._url = url
  }
}

module.exports = Writer
