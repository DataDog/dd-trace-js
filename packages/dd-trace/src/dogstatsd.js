'use strict'

const dgram = require('dgram')
const lookup = require('dns').lookup // cache to avoid instrumentation
const log = require('./log')

const MAX_BUFFER_SIZE = 1024 // limit from the agent

class Client {
  constructor (options) {
    options = options || {}

    this._host = options.host || 'localhost'
    this._port = options.port || 8125
    this._prefix = options.prefix || ''
    this._tags = options.tags || []
    this._queue = []
    this._buffer = ''
    this._offset = 0
    this._udp4 = this._socket('udp4')
    this._udp6 = this._socket('udp6')
  }

  gauge (stat, value, tags) {
    this._add(stat, value, 'g', tags)
  }

  increment (stat, value, tags) {
    this._add(stat, value, 'c', tags)
  }

  flush () {
    const queue = this._enqueue()

    if (this._queue.length === 0) return

    this._queue = []

    lookup(this._host, (err, address, family) => {
      if (err) return log.error(err)

      queue.forEach(buffer => this._send(address, family, buffer))
    })
  }

  _send (address, family, buffer) {
    const socket = family === 6 ? this._udp6 : this._udp4

    log.debug(`Sending to DogStatsD: ${buffer}`)

    socket.send(buffer, 0, buffer.length, this._port, address)
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
    const offset = Buffer.byteLength(message)

    if (this._offset + offset > MAX_BUFFER_SIZE) {
      this._enqueue()
    }

    this._offset += offset
    this._buffer += message
  }

  _enqueue () {
    if (this._offset > 0) {
      this._queue.push(Buffer.from(this._buffer))
      this._buffer = ''
      this._offset = 0
    }

    return this._queue
  }

  _socket (type) {
    const socket = dgram.createSocket(type)

    socket.on('error', () => {})
    socket.unref()

    return socket
  }
}

module.exports = Client
