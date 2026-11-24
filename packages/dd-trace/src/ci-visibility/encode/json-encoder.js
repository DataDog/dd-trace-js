'use strict'

const ByteBatch = require('./byte-batch')

class JSONEncoder {
  /** @type {ByteBatch<string> | undefined} */
  #batch
  /** @type {unknown[]} */
  #payloads = []

  /**
   * @param {number} [maxBytes]
   */
  constructor (maxBytes) {
    if (maxBytes !== undefined) this.#batch = new ByteBatch(maxBytes)
  }

  /**
   * @param {unknown} payload
   */
  encode (payload) {
    if (this.#batch !== undefined) {
      const data = JSON.stringify(payload) ?? 'null'
      return this.#batch.append(data, Buffer.byteLength(data))
    }
    this.#payloads.push(payload)
    return true
  }

  count () {
    return this.#batch?.count() ?? this.#payloads.length
  }

  makePayload () {
    if (this.#batch === undefined) {
      const data = JSON.stringify(this.#payloads)
      this.#payloads = []
      return data
    }
    const items = this.#batch.take()
    if (items.length === 0) return ['[', ']']

    const data = new Array(items.length * 2 + 1)
    data[0] = '['
    for (let index = 0; index < items.length; index++) {
      data[index * 2 + 1] = items[index]
      data[index * 2 + 2] = index === items.length - 1 ? ']' : ','
    }
    return data
  }
}

module.exports = { JSONEncoder }
