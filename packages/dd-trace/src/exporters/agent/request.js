'use strict'

const http = require('http')
const https = require('https')
const docker = require('./docker')
const log = require('../../log')
const { storage } = require('../../../../datadog-core')

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({ keepAlive: true })
const containerId = docker.id()

function retriableRequest (options, callback, client, data) {
  const store = storage.getStore()

  storage.enterWith({ noop: true })

  const req = client.request(options, res => {
    let data = ''

    res.setTimeout(options.timeout)

    res.on('data', chunk => { data += chunk })
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode <= 299) {
        callback(null, data, res.statusCode)
      } else {
        const error = new Error(`Error from the agent: ${res.statusCode} ${http.STATUS_CODES[res.statusCode]}`)
        error.status = res.statusCode

        callback(error, null, res.statusCode)
      }
    })
  })
  req.setTimeout(options.timeout, req.abort)
  data.forEach(buffer => req.write(buffer))

  storage.enterWith(store)

  return req
}

function request (options, callback) {
  options = Object.assign({
    headers: {},
    data: [],
    timeout: 2000
  }, options)

  const data = [].concat(options.data)
  const isSecure = options.protocol === 'https:'
  const client = isSecure ? https : http
  const agent = isSecure ? httpsAgent : httpAgent

  options.agent = agent
  options.headers['Content-Length'] = byteLength(data)

  if (containerId) {
    options.headers['Datadog-Container-ID'] = containerId
  }
  const firstRequest = retriableRequest(options, callback, client, data)

  // The first request will be retried if it fails due to a socket connection close
  const firstRequestErrorHandler = error => {
    if (firstRequest.reusedSocket && (error.code === 'ECONNRESET' || error.code === 'EPIPE')) {
      log.debug('Retrying request due to socket connection error')
      const retriedReq = retriableRequest(options, callback, client, data)
      // The retried request will fail normally
      retriedReq.on('error', e => callback(new Error(`Network error trying to reach the agent: ${e.message}`)))
      retriedReq.end()
    } else {
      callback(new Error(`Network error trying to reach the agent: ${error.message}`))
    }
  }

  firstRequest.on('error', firstRequestErrorHandler)
  firstRequest.end()

  return firstRequest
}

function byteLength (data) {
  return data.length > 0 ? data.reduce((prev, next) => prev + next.length, 0) : 0
}

module.exports = request
