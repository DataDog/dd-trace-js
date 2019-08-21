'use strict'

const { randomBytes } = require('crypto')

module.exports = {
  getRandomValues (typedArray) {
    const size = typedArray.length * typedArray.BYTES_PER_ELEMENT
    const buffer = randomBytes(size).buffer

    typedArray.set(new typedArray.constructor(buffer))
  }
}
