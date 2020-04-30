'use strict'

const platform = require('../../platform')
const log = require('../../log')
const encode = require('../../encode')
const tracerVersion = require('../../../lib/version')

const MAX_SIZE = 8 * 1024 * 1024 // 8MB
const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'

class Writer {
  constructor (url, prioritySampler) {
    this._url = url
    this._prioritySampler = prioritySampler

    this._reset()
  }

  get length () {
    return this._count
  }

  append (spans) {
    log.debug(() => `Encoding trace: ${JSON.stringify(spans)}`)

    this._encode(spans)
  }

  flush () {
    if (this._count > 0) {
      const data = platform.msgpack.prefix(this._buffer.slice(0, this._offset), this._count)

      this._request(data, this._count)

      this._reset()
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

  _encode (trace) {
    const offset = this._offset
    try {
      this._offset = encode(this._buffer, this._offset, trace, this)
      this._count++
    } catch (e) {
      if (e instanceof RangeError) {
        log.error(e.message)
      } else {
        throw e
      }
    }

    log.debug(() => [
      'Added encoded trace to buffer:',
      this._buffer.slice(offset, this._offset).toString('hex').match(/../g).join(' ')
    ].join(' '))
  }

  _reset () {
    this._buffer = Buffer.allocUnsafe(MAX_SIZE)
    this._offset = 5 // we'll use these first bytes to hold an array prefix
    this._count = 0
  }
}

module.exports = Writer
