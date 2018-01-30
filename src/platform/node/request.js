'use strict'

const http = require('http')

function request (options, callback) {
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
}

function byteLength (data) {
  return data.length > 0 ? data.reduce((prev, next) => prev + next.length, 0) : 0
}

module.exports = request
