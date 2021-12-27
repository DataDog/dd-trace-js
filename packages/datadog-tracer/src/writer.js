'use strict'

const http = require('http')
const { Encoder } = require('./encoder')

class Writer {
  constructor () {
    this._encoder = new Encoder(this)
  }

  write (spans) {
    this._encoder.encode(spans)
  }

  flush () {
    if (this._encoder.count() === 0) return

    const data = this._encoder.makePayload()
    const timeout = 2000
    const options = {
      hostname: 'localhost',
      port: 8126,
      path: '/v0.5/traces',
      method: 'PUT',
      headers: {
        'Content-Length': data.length,
        'Content-Type': 'application/msgpack'
      },
      data,
      timeout
    }
    const req = http.request(options, res => {
      res.setTimeout(timeout)
      res.resume()
    })

    req.on('error', () => {})

    req.setTimeout(timeout, req.abort)
    req.write(data)
  }
}

module.exports = { Writer }
