'use strict'

const https = require('https')
const http = require('http')
const log = require('../../../log')

function retriableRequest (data, options, callback) {
  const client = options.protocol === 'https:' ? https : http

  const timeout = options.timeout || 15000

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

  // The first request will be retried
  const firstRequestErrorHandler = () => {
    log.debug('Retrying request to the intake')
    const retriedReq = retriableRequest(data, options, callback)
    // The retried request will fail normally
    retriedReq.on('error', e => callback(new Error(`Network error trying to reach the intake: ${e.message}`)))
    retriedReq.end()
  }

  firstRequest.on('error', firstRequestErrorHandler)
  firstRequest.end()

  return firstRequest
}

module.exports = request
