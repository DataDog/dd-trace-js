'use strict'

/** @template Item */
class ByteBatch {
  #maxBytes
  #bytes = 2
  /** @type {Item[]} */
  #items = []

  /** @param {number} maxBytes */
  constructor (maxBytes) {
    this.#maxBytes = maxBytes
  }

  /**
   * Accounts for the surrounding array and separators in addition to item bytes.
   * @param {Item} item
   * @param {number} bytes
   */
  append (item, bytes) {
    const total = this.#bytes + bytes + (this.#items.length === 0 ? 0 : 1)
    if (total > this.#maxBytes) return false
    this.#bytes = total
    this.#items.push(item)
    return true
  }

  count () {
    return this.#items.length
  }

  take () {
    const items = this.#items
    this.#items = []
    this.#bytes = 2
    return items
  }
}

module.exports = ByteBatch
