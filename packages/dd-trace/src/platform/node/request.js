'use strict'

const http = require('http')
const https = require('https')

function request (options, callback) {
  options = Object.assign({
    headers: {},
    data: [],
    timeout: 2000
  }, options)

  const data = [].concat(options.data)

  options.headers['Content-Length'] = byteLength(data)

  return new Promise((resolve, reject) => {
    const client = options.protocol === 'https:' ? https : http
    const req = client.request(options, res => {
      let data = ''

      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode <= 299) {
          resolve(data)
        } else {
          const error = new Error(http.STATUS_CODES[res.statusCode])
          error.status = res.statusCode

          reject(new Error(`Error from the agent: ${res.statusCode} ${http.STATUS_CODES[res.statusCode]}`))
        }
      })
    })

    req.setTimeout(options.timeout, req.abort)
    req.on('error', e => reject(new Error(`Network error trying to reach the agent: ${e.message}`)))

    data.forEach(buffer => req.write(buffer))

    req.end()
  })
}

function byteLength (data) {
  return data.length > 0 ? data.reduce((prev, next) => prev + next.length, 0) : 0
}

module.exports = request
