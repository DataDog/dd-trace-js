'use strict'

const platform = require('./platform')
const log = require('./log')
const format = require('./format')
const encode = require('./encode')
const tracerVersion = require('../lib/version')

class Writer {
  constructor (url, size) {
    this._url = url
    this._size = size

    this._reset()
  }

  get length () {
    return this._count
  }

  append (span) {
    const trace = span.context().trace

    if (trace.started.length === trace.finished.length) {
      const formattedTrace = trace.finished.map(format)

      this._offset = encode(this._buffer, this._offset, formattedTrace)
      this._count++

      // log.debug(() => `Encoding trace: ${JSON.stringify(formattedTrace)}`)

      // const buffer = encode(formattedTrace)

      // log.debug(() => `Adding encoded trace to buffer: ${buffer.toString('hex').match(/../g).join(' ')}`)

      // if (this.length < this._size) {
      //   this._queue.push(buffer)
      // } else {
      //   this._squeeze(buffer)
      // }
    }
  }

  flush () {
    if (this._count > 0) {
      const data = [].concat(platform.msgpack.getPrefix(this._count), this._buffer)

      const options = {
        protocol: this._url.protocol,
        hostname: this._url.hostname,
        port: this._url.port,
        path: '/v0.3/traces',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/msgpack',
          'Datadog-Meta-Lang': platform.name(),
          'Datadog-Meta-Lang-Version': platform.version(),
          'Datadog-Meta-Lang-Interpreter': platform.engine(),
          'Datadog-Meta-Tracer-Version': tracerVersion,
          'X-Datadog-Trace-Count': String(this._count)
        }
      }

      log.debug(() => `Request to the agent: ${JSON.stringify(options)}`)

      platform
        .request(Object.assign({ data }, options))
        .then(res => log.debug(`Response from the agent: ${res}`))
        .catch(e => log.error(e))

      this._reset()
    }
  }

  _squeeze (buffer) {
    const index = Math.floor(Math.random() * this.length)
    this._queue[index] = buffer
  }

  _reset () {
    this._offset = 0
    this._count = 0
    this._buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
  }
}

module.exports = Writer
