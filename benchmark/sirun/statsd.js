'use strict'

const dgram = require('dgram')
const port = process.env.SIRUN_STATSD_PORT || 8125

class StatsD {
  constructor (options) {
    options = options || {}

    this._prefix = options.prefix || ''
    this._buffer = ''
    this._udp = this._socket('udp4')
  }

  gauge (stat, value) {
    this._add(stat, value, 'g')
  }

  flush () {
    const buffer = this._buffer

    if (buffer.length === 0) return

    this._buffer = ''

    this._udp.send(buffer, 0, buffer.length, port)
  }

  _add (stat, value, type) {
    this._buffer += `${this._prefix + stat}:${value}|${type}\n`
  }

  _socket (type) {
    const socket = dgram.createSocket(type)

    socket.on('error', () => {})
    socket.unref()

    return socket
  }
}

module.exports = StatsD
