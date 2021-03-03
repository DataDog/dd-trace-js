'use strict'

const dgram = require('dgram')

class DogStatsD {
  constructor (options) {
    options = options || {}

    this._prefix = options.prefix || ''
    this._tags = options.tags || []
    this._buffer = ''
    this._udp = this._socket('udp4')
  }

  gauge (stat, value, tags) {
    this._add(stat, value, 'g', tags)
  }

  increment (stat, value, tags) {
    this._add(stat, value, 'c', tags)
  }

  flush () {
    const buffer = this._buffer

    if (buffer.length === 0) return

    this._buffer = ''

    this._udp.send(buffer, 0, buffer.length, 8125)
  }

  _add (stat, value, type, tags) {
    const message = `${this._prefix + stat}:${value}|${type}`

    tags = tags ? this._tags.concat(tags) : this._tags

    if (tags.length > 0) {
      this._write(`${message}|#${tags.join(',')}\n`)
    } else {
      this._write(`${message}\n`)
    }
  }

  _write (message) {
    this._buffer += message
  }

  _socket (type) {
    const socket = dgram.createSocket(type)

    socket.on('error', () => {})
    socket.unref()

    return socket
  }
}

module.exports = DogStatsD
