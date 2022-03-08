'use strict'

const https = require('https')
const http = require('http')

function retriableRequest (data, options, callback) {
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
  request.write(data)

  return request
}

function request (data, options, callback) {
  const firstRequest = retriableRequest(data, options, callback)

  // The first request will be retried if it fails due to a socket connection close
  const firstRequestErrorHandler = error => {
    if (firstRequest.reusedSocket && (error.code === 'ECONNRESET' || error.code === 'EPIPE')) {
      const retriedReq = retriableRequest(data, options, callback)
      // The retried request will fail normally
      retriedReq.on('error', e => callback(new Error(`Network error trying to reach the intake: ${e.message}`)))
      retriedReq.end()
    } else {
      callback(new Error(`Network error trying to reach the intake: ${error.message}`))
    }
  }

  firstRequest.on('error', firstRequestErrorHandler)
  firstRequest.end()

  return firstRequest
}

module.exports = request
