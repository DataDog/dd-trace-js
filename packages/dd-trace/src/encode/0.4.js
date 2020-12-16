'use strict'

const { encode } = require('./notepack')
const log = require('../log')

const HARD_LIMIT = 8 * 1024 * 1024 // 8MB

class AgentEncoder {
  constructor (writer) {
    this._writer = writer
    this._reset()
  }

  count () {
    return this._traces.length
  }

  encode (trace) {
    const buffer = encode(trace)

    log.debug(() => `Adding encoded trace to buffer: ${buffer.toString('hex').match(/../g).join(' ')}`)

    if (buffer.length + this._size > HARD_LIMIT) {
      this._writer.flush()
    }

    this._size += buffer.length
    this._traces.push(buffer)
  }

  makePayload () {
    const prefix = Buffer.allocUnsafe(5)

    prefix[0] = 0xdd
    prefix.writeUInt32BE(this._traces.length, 1)

    const buffer = [prefix, ...this._traces]

    this._reset()

    return buffer
  }

  _reset () {
    this._traces = []
    this._size = 0
  }
}

module.exports = { AgentEncoder }
