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
      const serializedPayload = JSON.stringify(payload) ?? 'null'
      const payloadBytes = Buffer.byteLength(serializedPayload)
      const separatorBytes = this.payloads.length === 0 ? 0 : 1
      if (payloadBytes + separatorBytes > this.#maxBytes - this.#bytes) return false
      this.#bytes += payloadBytes + separatorBytes
      this.payloads.push(serializedPayload)
      return true
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
    let data
    if (this.#maxBytes === undefined) {
      data = JSON.stringify(this.payloads)
    } else if (this.payloads.length === 0) {
      data = ['[', ']']
    } else {
      data = new Array(this.payloads.length * 2 + 1)
      data[0] = '['
      for (let index = 0; index < this.payloads.length; index++) {
        data[index * 2 + 1] = this.payloads[index]
        data[index * 2 + 2] = index === this.payloads.length - 1 ? ']' : ','
      }
    }
    this.reset()
    return data
  }
}

module.exports = { JSONEncoder }
