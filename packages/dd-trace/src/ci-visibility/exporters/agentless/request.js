'use strict'

const https = require('https')
const http = require('http')

const log = require('../../../log')
const retriableRequest = require('../../../exporters/common/request')

function request (data, options, callback) {
  const client = options.protocol === 'https:' ? https : http

  const firstRequest = retriableRequest(options, client, callback)
  firstRequest.write(data)

  // The first request will be retried
  const firstRequestErrorHandler = () => {
    log.debug('Retrying request to the intake')
    const retriedReq = retriableRequest(options, client, callback)
    retriedReq.write(data)
    // The retried request will fail normally
    retriedReq.on('error', e => callback(new Error(`Network error trying to reach the intake: ${e.message}`)))
    retriedReq.end()
  }

  firstRequest.on('error', firstRequestErrorHandler)
  firstRequest.end()

  return firstRequest
}

module.exports = request
