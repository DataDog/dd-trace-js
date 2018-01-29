'use strict'

const http = require('http')
const Buffer = require('safe-buffer').Buffer

module.exports = {
  request (options, callback) {
    options = Object.assign({
      headers: {},
      data: [],
      timeout: 2000
    }, options)

    const data = [].concat(options.data)

    options.headers['Content-Length'] = byteLength(data)

    return new Promise((resolve, reject) => {
      const req = http.request(options, res => {
        res.on('data', chunk => {})
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode <= 299) {
            resolve()
          } else {
            const error = new Error(http.STATUS_CODES[res.statusCode])
            error.status = res.statusCode

            reject(error)
          }
        })
      })

      req.setTimeout(options.timeout, req.abort)
      req.on('error', reject)

      data.forEach(buffer => req.write(buffer))

      req.end()
    })
  },

  msgpackArrayPrefix (length) {
    let buffer

    if (length <= 0xf) { // fixarray
      buffer = Buffer.alloc(1)
      buffer.fill(0x90 + length)
    } else if (length <= 0xffff) { // array 16
      buffer = Buffer.alloc(3)
      buffer.fill(0xdc, 0, 1)
      buffer.writeUInt16BE(length, 1)
    } else { // array 32
      buffer = Buffer.alloc(5)
      buffer.fill(0xdd, 0, 1)
      buffer.writeUInt32BE(length, 1)
    }

    return buffer
  }
}

function byteLength (data) {
  return data.length > 0 ? data.reduce((prev, next) => prev + next.length, 0) : 0
}
