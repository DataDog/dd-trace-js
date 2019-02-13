'use strict'

const platform = require('./platform')
const log = require('./log')
const format = require('./format')
const encode = require('./encode')
const tracerVersion = require('../lib/version')

class Writer {
  constructor (prioritySampler, url, size) {
    this._queue = []
    this._prioritySampler = prioritySampler
    this._url = url
    this._size = size
  }

  get length () {
    return this._queue.length
  }

  append (span) {
    const spanContext = span.context()
    const trace = spanContext._trace

    if (trace.started.length === trace.finished.length) {
      const formattedTrace = trace.finished.map(format)

      if (spanContext._sampling.drop === true) {
        log.debug(() => `Dropping trace due to user configured filtering: ${JSON.stringify(formattedTrace)}`)
        return
      }

      log.debug(() => `Encoding trace: ${JSON.stringify(formattedTrace)}`)

      const buffer = encode(formattedTrace)

      log.debug(() => `Adding encoded trace to buffer: ${buffer.toString('hex').match(/../g).join(' ')}`)

      if (this.length < this._size) {
        this._queue.push(buffer)
      } else {
        this._squeeze(buffer)
      }
    }
  }

  flush () {
    if (this._queue.length > 0) {
      const data = platform.msgpack.prefix(this._queue)

      this._request(data, this._queue.length)

      this._queue = []
    }
  }

  _request (data, count) {
    const options = {
      protocol: this._url.protocol,
      hostname: this._url.hostname,
      port: this._url.port,
      path: '/v0.4/traces',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/msgpack',
        'Datadog-Meta-Lang': platform.name(),
        'Datadog-Meta-Lang-Version': platform.version(),
        'Datadog-Meta-Lang-Interpreter': platform.engine(),
        'Datadog-Meta-Tracer-Version': tracerVersion,
        'X-Datadog-Trace-Count': String(count)
      }
    }

    log.debug(() => `Request to the agent: ${JSON.stringify(options)}`)

    platform
      .request(Object.assign({ data }, options))
      .then(res => {
        log.debug(`Response from the agent: ${res}`)

        this._prioritySampler.update(JSON.parse(res).rate_by_service)
      })
      .catch(e => log.error(e))
  }

  _squeeze (buffer) {
    const index = Math.floor(Math.random() * this.length)
    this._queue[index] = buffer
  }
}

module.exports = Writer
