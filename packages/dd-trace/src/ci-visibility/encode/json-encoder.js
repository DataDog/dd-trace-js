'use strict'

class JSONEncoder {
  #bytes = 2
  #maxBytes

  /**
   * @param {number} [maxBytes]
   */
  constructor (maxBytes) {
    this.#maxBytes = maxBytes
    this.payloads = []
  }

  encode (payload) {
    if (this.#maxBytes !== undefined) {
      const payloadBytes = Buffer.byteLength(JSON.stringify(payload))
      const separatorBytes = this.payloads.length === 0 ? 0 : 1
      if (payloadBytes + separatorBytes > this.#maxBytes - this.#bytes) return false
      this.#bytes += payloadBytes + separatorBytes
    }
    this.payloads.push(payload)
    return true
  }

  count () {
    return this.payloads.length
  }

  reset () {
    this.#bytes = 2
    this.payloads = []
  }

  makePayload () {
    const data = JSON.stringify(this.payloads)
    this.reset()
    return data
  }
}

module.exports = { JSONEncoder }
