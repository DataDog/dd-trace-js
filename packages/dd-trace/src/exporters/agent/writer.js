'use strict'

const platform = require('../../platform')
const log = require('../../log')
const encode = require('../../encode')
const tracerVersion = require('../../../lib/version')

const MAX_SIZE = 8 * 1024 * 1024 // 8MB
const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'

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

    if (buffer.length + this._size > MAX_SIZE) {
      this.flush()
    }

    this._size += buffer.length
    this._queue.push(buffer)
  }

  flush () {
    if (this._queue.length > 0) {
      const data = platform.msgpack.prefix(this._queue)

      this._request(data, this._queue.length)

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

    platform.metrics().increment(`${METRIC_PREFIX}.requests`, true)

    platform.request(Object.assign({ data }, options), (err, res, status) => {
      if (status) {
        platform.metrics().increment(`${METRIC_PREFIX}.responses`, true)
        platform.metrics().increment(`${METRIC_PREFIX}.responses.by.status`, `status:${status}`, true)
      } else if (err) {
        platform.metrics().increment(`${METRIC_PREFIX}.errors`, true)
        platform.metrics().increment(`${METRIC_PREFIX}.errors.by.name`, `name:${err.name}`, true)

        if (err.code) {
          platform.metrics().increment(`${METRIC_PREFIX}.errors.by.code`, `code:${err.code}`, true)
        }
      }

      if (err) return log.error(err)

      log.debug(`Response from the agent: ${res}`)

      try {
        this._prioritySampler.update(JSON.parse(res).rate_by_service)
      } catch (e) {
        log.error(e)

        platform.metrics().increment(`${METRIC_PREFIX}.errors`, true)
        platform.metrics().increment(`${METRIC_PREFIX}.errors.by.name`, `name:${e.name}`, true)
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
