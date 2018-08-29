'use strict'

const lru = require('tiny-lru')
const tokens = require('./tokens')
const util = require('./util')

function cache (max) {
  const cache = lru(max)

  return value => {
    let item = cache.get(value)

    if (!item) {
      const buffer = Buffer.from(value, 'utf-8')

      item = Buffer.concat([
        prefix(buffer.length),
        buffer
      ])

      cache.set(value, item)
    }

    return item
  }
}

function prefix (length) {
  if (length <= 0xffff) {
    return tokens.str[length]
  }

  const buffer = Buffer.allocUnsafe(5)

  util.writeUInt8(buffer, 0xdb, 0)
  util.writeUInt32(buffer, length, 1)

  return buffer
}

module.exports = cache
