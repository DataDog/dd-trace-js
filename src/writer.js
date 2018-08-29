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
      if (this._count >= this._size) {
        this.flush()
      }

      const formattedTrace = trace.finished.map(format)

      log.debug(() => `Encoding trace: ${JSON.stringify(formattedTrace)}`)

      this._encode(formattedTrace)
    }
  }

  flush () {
    if (this._count > 0) {
      const prefix = platform.msgpack.prefix(this._count)
      const buffer = Buffer.from(this._buffer.buffer, 0, this._offset)
      const data = [].concat(prefix, buffer)

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
    }

    this._reset()
  }

  _encode (trace) {
    const offset = this._offset

    try {
      this._offset = encode(this._buffer, this._offset, trace)
      this._count++
    } catch (e) {
      if (e.name.startsWith('RangeError')) {
        if (offset === 0) {
          return log.error('Dropping trace because its payload is too large.')
        }

        this._offset = offset

        this.flush()
        this._encode(trace)
      } else {
        log.error(e)
      }

      return
    }

    log.debug(() => [
      'Added encoded trace to buffer:',
      this._buffer.slice(offset, this._offset).toString('hex').match(/../g).join(' ')
    ].join(' '))
  }

  _reset () {
    this._offset = 0
    this._count = 0
    this._buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
  }
}

module.exports = Writer
