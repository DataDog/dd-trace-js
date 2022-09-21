'use strict'

const lookup = require('dns').lookup // cache to avoid instrumentation
const request = require('./exporters/common/request')
const dgram = require('dgram')
const url = require('url')
const isIP = require('net').isIP
const log = require('./log')

const MAX_BUFFER_SIZE = 1024 // limit from the agent

class Client {
  constructor (options) {
    options = options || {}

    if (options.metricsProxyUrl) {
      this._httpOptions = {
        url: options.metricsProxyUrl.toString(),
        agent: null,
        path: '/dogstatsd/v1/proxy'
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

  flush (cb) {
    const queue = this._enqueue()

    if (this._queue.length === 0) return

    this._queue = []

    if (this._httpOptions) {
      requestQueue(queue, this._httpOptions, err => {
        if (err) {
          log.debug('HTTP error from agent: ' + err.stack)
          if (err.status) {
            // Inside this if-block, we have connectivity to the agent, but
            // we're not getting a 200 from the proxy endpoint. Fall back to
            // UDP and try again.
            this._httpOptions = null
            this._queue = queue
            this.flush()
          }
        }
        if (cb) {
          cb(err)
        }
      })
    } else if (this._family !== 0) {
      this._sendAll(queue, this._host, this._family)
    } else {
      lookup(this._host, (err, address, family) => {
        if (err) return log.error(err)
        this._sendAll(queue, address, family)
      })
    }
  }

  _send (address, family, buffer) {
    const socket = family === 6 ? this._udp6 : this._udp4

    log.debug(`Sending to DogStatsD: ${buffer}`)

    socket.send(buffer, 0, buffer.length, this._port, address)
  }

  _sendAll (queue, address, family) {
    queue.forEach((buffer) => this._send(address, family, buffer))
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

function requestQueue (queue, options, callback) {
  if (!queue.length) {
    callback()
    return
  }

  const [data, ...newQueue] = queue
  request(data, options, (err, _, code) => {
    if (err) {
      callback(err)
      return
    }
    if (code !== 200) {
      callback(new Error('response code from the trace agent: ' + code))
      return
    }
    requestQueue(newQueue, options, callback)
  })
}
