'use strict'

const http = require('http')

module.exports = {
  request (options, callback) {
    options = Object.assign({
      headers: {},
      timeout: 2000
    }, options)

    options.headers['Content-Length'] = byteLength(options.data)

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

      req.write(options.data)
      req.end()
    })
  }
}

function byteLength (data) {
  return data ? data.length : 0
}
