'use strict'

class JSONEncoder {
  constructor () {
    this.payloads = []
  }

  encode (payload) {
    this.payloads.push(payload)
  }

  count () {
    return this.payloads.length
  }

  reset () {
    this.payloads = []
  }

  makePayload () {
    const data = JSON.stringify(this.payloads)
    this.reset()
    return data
  }
}

module.exports = { JSONEncoder }
