'use strict'

const platform = require('../../platform')
const tracerVersion = require('../../../lib/version')
const msgpack = require('msgpack-lite')

const Writer05 = require('./writer-0.5')
const Writer04 = require('./writer-0.4')

class Writer {
  constructor (url, prioritySampler, lookup) {
    this._appends = []
    this._needsFlush = false

    const fakeWriter = Object.create(Writer05.prototype)
    fakeWriter._url = url
    fakeWriter._prioritySampler = prioritySampler
    fakeWriter._lookup = lookup

    const options = {
      path: '/v0.5/traces',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/msgpack',
        'Datadog-Meta-Tracer-Version': tracerVersion,
        'X-Datadog-Trace-Count': '0'
      },
      lookup: fakeWriter._lookup
    }

    fakeWriter._setHeader(options.headers, 'Datadog-Meta-Lang', platform.name())
    fakeWriter._setHeader(options.headers, 'Datadog-Meta-Lang-Version', platform.version())
    fakeWriter._setHeader(options.headers, 'Datadog-Meta-Lang-Interpreter', platform.engine())

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
