'use strict'

const lookup = require('dns').lookup // cache to avoid instrumentation
const request = require('./exporters/common/request')
const dgram = require('dgram')
const isIP = require('net').isIP
const log = require('./log')

const MAX_BUFFER_SIZE = 1024 // limit from the agent

class Client {
  constructor (options) {
    options = options || {}

    if (options.metricsProxyUrl) {
      this._httpOptions = {
        url: options.metricsProxyUrl.toString(),
        path: '/dogstatsd/v2/proxy'
      }
    }

    this._host = options.host || 'localhost'
    this._family = isIP(this._host)
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

    if (this._httpOptions) {
      this._sendHttp(queue)
    } else {
      this._sendUdp(queue)
    }
  }

  _sendHttp (queue) {
    const buffer = Buffer.concat(queue)
    request(buffer, this._httpOptions, (err) => {
      if (err) {
        log.error('HTTP error from agent: ' + err.stack)
        if (err.status) {
          // Inside this if-block, we have connectivity to the agent, but
          // we're not getting a 200 from the proxy endpoint. If it's a 404,
          // then we know we'll never have the endpoint, so just clear out the
          // options. Either way, we can give UDP a try.
          if (err.status === 404) {
            this._httpOptions = null
          }
          this._sendUdp(queue)
        }
      }
    })
  }

  _sendUdp (queue) {
    if (this._family !== 0) {
      this._sendUdpFromQueue(queue, this._host, this._family)
    } else {
      lookup(this._host, (err, address, family) => {
        if (err) return log.error(err)
        this._sendUdpFromQueue(queue, address, family)
      })
    }
  }

  _sendUdpFromQueue (queue, address, family) {
    const socket = family === 6 ? this._udp6 : this._udp4

    queue.forEach((buffer) => {
      log.debug(`Sending to DogStatsD: ${buffer}`)
      socket.send(buffer, 0, buffer.length, this._port, address)
    })
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
