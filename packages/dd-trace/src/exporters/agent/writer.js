'use strict'

const platform = require('../../platform')
const tracerVersion = require('../../../lib/version')
const msgpack = require('msgpack-lite')

const Writer05 = require('./writer-0.5')
const Writer04 = require('./writer-0.4')
const BaseWriter = require('./base-writer')

const { _setHeader: setHeader } = BaseWriter.prototype

class Writer {
  constructor (url, prioritySampler, lookup) {
    this._appends = []
    this._needsFlush = false

    const options = {
      path: '/v0.5/traces',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/msgpack',
        'Datadog-Meta-Tracer-Version': tracerVersion,
        'X-Datadog-Trace-Count': '0'
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

    const payload = { data: [msgpack.encode([[], []])] }
    platform.request(Object.assign(payload, options), (err) => {
      if (err) {
        this._writer = new Writer04(url, prioritySampler, lookup)
      } else {
        this._writer = new Writer05(url, prioritySampler, lookup)
      }
      for (const spans of this._appends) {
        this._writer.append(spans)
      }
      if (this._needsFlush) {
        this._writer.flush()
      }
      const writer = this._writer
      this.append = function (spans) {
        writer.append(spans)
      }
      this.flush = function () {
        writer.flush()
      }
    })
  }

  append (spans) {
    this._appends.push(spans)
  }

  flush () {
    this._needsFlush = true
  }
}

module.exports = Writer
