'use strict'

const platform = require('../../platform')
const log = require('../../log')
const encode = require('../../encode')
const tracerVersion = require('../../../lib/version')

const MAX_SIZE = 8 * 1024 * 1024 // 8MB

class Writer {
  constructor (url, prioritySampler) {
    this._queue = []
    this._url = url
    this._prioritySampler = prioritySampler
    this._size = 0
  }

  get length () {
    return this._queue.length
  }

  append (spans) {
    log.debug(() => `Encoding trace: ${JSON.stringify(spans)}`)

    const buffer = encode(spans)

    log.debug(() => `Adding encoded trace to buffer: ${buffer.toString('hex').match(/../g).join(' ')}`)

    platform.metrics().histogram('datadog.tracer.node.exporter.agent.trace_size', buffer.length)

    if (buffer.length + this._size > MAX_SIZE) {
      this.flush()
    }

    this._size += buffer.length
    this._queue.push(buffer)
  }

  flush () {
    if (this._queue.length > 0) {
      const data = platform.msgpack.prefix(this._queue)
      const size = data.reduce((prev, next) => prev + next.length, 0)

      this._request(data, this._queue.length)

      platform.metrics().histogram('datadog.tracer.node.exporter.agent.payload_size', size)

      this._queue = []
      this._size = 0
    }
  }

  _request (data, count) {
    const options = {
      path: '/v0.4/traces',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/msgpack',
        'Datadog-Meta-Tracer-Version': tracerVersion,
        'X-Datadog-Trace-Count': String(count)
      }
    }

    this._setHeader(options.headers, 'Datadog-Meta-Lang', platform.name())
    this._setHeader(options.headers, 'Datadog-Meta-Lang-Version', platform.version())
    this._setHeader(options.headers, 'Datadog-Meta-Lang-Interpreter', platform.engine())

    if (this._url.protocol === 'unix:') {
      options.socketPath = this._url.pathname
    } else {
      options.protocol = this._url.protocol
      options.hostname = this._url.hostname
      options.port = this._url.port
    }

    log.debug(() => `Request to the agent: ${JSON.stringify(options)}`)

    platform.metrics().increment('datadog.tracer.node.exporter.agent.requests')

    platform.request(Object.assign({ data }, options), (err, res, status) => {
      if (status) {
        platform.metrics().increment('datadog.tracer.node.exporter.agent.responses')
        platform.metrics().increment('datadog.tracer.node.exporter.agent.responses', `status:${status}`)
      } else {
        platform.metrics().increment('datadog.tracer.node.exporter.agent.errors')

        if (err && err.code) {
          platform.metrics().increment('datadog.tracer.node.exporter.agent.errors.by.code', `code:${err.code}`)
        }
      }

      if (err) return log.error(err)

      log.debug(`Response from the agent: ${res}`)

      try {
        this._prioritySampler.update(JSON.parse(res).rate_by_service)
      } catch (e) {
        log.error(e)
      }
    })
  }

  _setHeader (headers, key, value) {
    if (value) {
      headers[key] = value
    }
  }
}

module.exports = Writer
