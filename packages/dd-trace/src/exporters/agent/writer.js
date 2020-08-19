'use strict'

const platform = require('../../platform')
const log = require('../../log')
const tracerVersion = require('../../../lib/version')
const msgpack = require('msgpack-lite')

const MAX_SIZE = 8 * 1024 * 1024 // 8MB
const METRIC_PREFIX = 'datadog.tracer.node.exporter.agent'

const arraySizeTwo = Buffer.from([0b10010010])

class BaseWriter {
  constructor (url, prioritySampler, lookup) {
    this._url = url
    this._prioritySampler = prioritySampler
    this._lookup = lookup
    this._appends = []
    this._needsFlush = false

    makeRequest('v0.5', [msgpack.encode([[], []])], '0', url, lookup, err => {
      if (err) {
        this._protocolVersion = 'v0.4'
        this._encodeForVersion = require('../../encode/0.4')
      } else {
        this._protocolVersion = 'v0.5'
        this._encodeForVersion = require('../../encode/0.5')
      }

      this._reset()

      for (const spans of this._appends) {
        this.append(spans)
      }
      if (this._needsFlush) {
        this.flush()
      }
    })
  }

  get length () {
    return this._count
  }

  append (spans) {
    if (this._protocolVersion) {
      log.debug(() => `Encoding trace: ${JSON.stringify(spans)}`)

      this._encode(spans)
    } else {
      this._appends.push(spans)
    }
  }

  _request (data, count) {
    platform.metrics().increment(`${METRIC_PREFIX}.requests`, true)

    makeRequest(this._protocolVersion, data, count, this._url, this._lookup, (err, res, status) => {
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

      platform.startupLog.startupLog({ agentError: err })

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

  _encode (trace) {
    const offset = this._offset
    try {
      this._offset = this._encodeForVersion(this._buffer, this._offset, trace, this)
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

    if (this._protocolVersion === 'v0.5') {
      this._strings = Buffer.allocUnsafe(MAX_SIZE)
      this._stringMap = {}
      this._stringMapLen = 0
      this._stringsBufLen = 3 // 0xdc and then uint16
      this._strings[0] = 0xdc
    }
  }

  flush () {
    if (this._protocolVersion) {
      if (this._count > 0) {
        const traceData = platform.msgpack.prefix(this._buffer.slice(0, this._offset), this._count)
        let data = traceData
        if (this._protocolVersion === 'v0.5') {
          data = makePayload(this, traceData)
        }

        this._request(data, this._count)

        this._reset()
      }
    } else {
      this._needsFlush = true
    }
  }
}

function makePayload (writer, traceData) {
  const strings = writer._strings.slice(0, writer._stringsBufLen)
  const stringsLen = Reflect.ownKeys(writer._stringMap).length
  strings.writeUInt16BE(stringsLen, 1)
  return [Buffer.concat([arraySizeTwo, strings, traceData[0]])]
}

function setHeader (headers, key, value) {
  if (value) {
    headers[key] = value
  }
}

function makeRequest (version, data, count, url, lookup, cb) {
  const options = {
    path: `/${version}/traces`,
    method: 'PUT',
    headers: {
      'Content-Type': 'application/msgpack',
      'Datadog-Meta-Tracer-Version': tracerVersion,
      'X-Datadog-Trace-Count': String(count)
    },
    lookup
  }

  setHeader(options.headers, 'Datadog-Meta-Lang', platform.name())
  setHeader(options.headers, 'Datadog-Meta-Lang-Version', platform.version())
  setHeader(options.headers, 'Datadog-Meta-Lang-Interpreter', platform.engine())

  if (url.protocol === 'unix:') {
    options.socketPath = url.pathname
  } else {
    options.protocol = url.protocol
    options.hostname = url.hostname
    options.port = url.port
  }

  log.debug(() => `Request to the agent: ${JSON.stringify(options)}`)

  platform.request(Object.assign({ data }, options), cb)
}

module.exports = BaseWriter
