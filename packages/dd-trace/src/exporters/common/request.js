'use strict'

const http = require('http')
const https = require('https')
const log = require('../../log')
const docker = require('./docker')
const { storage } = require('../../../../datadog-core')

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({ keepAlive: true })
const containerId = docker.id()

function request (data, options, keepAlive, callback) {
  if (!options.headers) {
    options.headers = {}
  }
  const isSecure = options.protocol === 'https:'
  const client = isSecure ? https : http
  const dataArray = [].concat(data)
  options.headers['Content-Length'] = byteLength(dataArray)

  if (containerId) {
    options.headers['Datadog-Container-ID'] = containerId
  }

  if (keepAlive) {
    options.agent = isSecure ? httpsAgent : httpAgent
  }

  const firstRequest = retriableRequest(options, client, callback)
  dataArray.forEach(buffer => firstRequest.write(buffer))

  // The first request will be retried
  const firstRequestErrorHandler = (e) => {
    log.debug('Retrying request to the intake: ' + e.stack)
    const retriedReq = retriableRequest(options, client, callback)
    dataArray.forEach(buffer => retriedReq.write(buffer))
    // The retried request will fail normally
    retriedReq.on('error', e => callback(new Error(`Network error trying to reach the intake: ${e.message}`)))
    retriedReq.end()
  }

  firstRequest.on('error', firstRequestErrorHandler)
  firstRequest.end()

  return firstRequest
}

function retriableRequest (options, client, callback) {
  const store = storage.getStore()

  storage.enterWith({ noop: true })

  const timeout = options.timeout || 15000

  const request = client.request(options, res => {
    let responseData = ''

    res.setTimeout(timeout)

    res.on('data', chunk => { responseData += chunk })
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode <= 299) {
        callback(null, responseData, res.statusCode)
      } else {
        const error = new Error(`Error from the endpoint: ${res.statusCode} ${http.STATUS_CODES[res.statusCode]}`)
        error.status = res.statusCode

        callback(error, null, res.statusCode)
      }
    })
  })
  request.setTimeout(timeout, request.abort)
  storage.enterWith(store)

  return request
}

function byteLength (data) {
  return data.length > 0 ? data.reduce((prev, next) => prev + next.length, 0) : 0
}

module.exports = request
