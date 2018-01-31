'use strict'

const platform = require('./platform')
const msgpack = require('msgpack-lite')
const codec = msgpack.createCodec({ int64: true })

class Writer {
  constructor (url, size) {
    this._queue = []
    this._url = url
    this._size = size
  }

  get length () {
    return this._queue.length
  }

  append (trace) {
    this._queue.push(msgpack.encode(trace, { codec }))

    if (this.length >= this._size) {
      this.flush()
    }
  }

  flush () {
    if (this._queue.length > 0) {
      const data = platform.msgpack.prefix(this._queue)

      platform.request({
        protocol: this._url.protocol,
        hostname: this._url.hostname,
        port: this._url.port,
        path: '/v0.3/traces',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/msgpack'
        },
        data
      })

      this._queue = []
    }
  }
}

module.exports = Writer
