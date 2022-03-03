'use strict'

const https = require('https')
const http = require('http')

function request (data, options, callback) {
  const client = options.protocol === 'https:' ? https : http

  const timeout = options.timeout || 2000

  const request = client.request(options, res => {
    let responseData = ''

    res.setTimeout(timeout)

    res.on('data', chunk => { responseData += chunk })
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode <= 299) {
        callback(null, responseData, res.statusCode)
      } else {
        const error = new Error(`Error from the intake: ${res.statusCode} ${http.STATUS_CODES[res.statusCode]}`)
        error.status = res.statusCode

        callback(error, null, res.statusCode)
      }
    })
  })
  request.setTimeout(timeout, request.abort)

  request.on('error', err => {
    callback(new Error(`Network error trying to reach the intake: ${err.message}`))
  })

  request.write(data)
  request.end()

  return request
}

module.exports = request
