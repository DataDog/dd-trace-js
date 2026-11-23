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

  /**
   * @param {unknown} payload
   * @param {(parts: string[]) => void} [flushBatch]
   */
  encode (payload, flushBatch) {
    if (this.#maxBytes !== undefined) {
      const serializedPayload = JSON.stringify(payload) ?? 'null'
      const payloadBytes = Buffer.byteLength(serializedPayload)
      if (payloadBytes + (this.payloads.length === 0 ? 0 : 1) > this.#maxBytes - this.#bytes) {
        if (flushBatch === undefined) {
          return false
        }
        if (this.payloads.length !== 0) {
          flushBatch(this.makePayload())
        }
        if (payloadBytes + 2 > this.#maxBytes) {
          flushBatch(['[', serializedPayload, ']'])
          return true
        }
      }
      this.#bytes += payloadBytes + (this.payloads.length === 0 ? 0 : 1)
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
