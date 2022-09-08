'use strict'

// TODO: Add test with slow or unresponsive agent.
// TODO: Add telemetry for things like dropped requests, errors, etc.

const { Readable } = require('stream')
const http = require('http')
const https = require('https')
const docker = require('./docker')
const { storage } = require('../../../../datadog-core')
const log = require('../../log')

const keepAlive = true
const maxSockets = 1
const maxActiveRequests = 8
const httpAgent = new http.Agent({ keepAlive, maxSockets })
const httpsAgent = new https.Agent({ keepAlive, maxSockets })
const containerId = docker.id()

let activeRequests = 0

function request (data, options, callback) {
  if (!options.headers) {
    options.headers = {}
  }

  const isReadable = data instanceof Readable

  // The timeout should be kept low to avoid excessive queueing.
  const timeout = options.timeout || 2000
  const isSecure = options.protocol === 'https:'
  const client = isSecure ? https : http
  const dataArray = [].concat(data)

  if (!isReadable) {
    options.headers['Content-Length'] = byteLength(dataArray)
  }

  if (containerId) {
    options.headers['Datadog-Container-ID'] = containerId
  }

  options.agent = 'agent' in options ? options.agent : isSecure ? httpsAgent : httpAgent

  const onResponse = res => {
    let responseData = ''

    res.setTimeout(timeout)

    res.on('data', chunk => { responseData += chunk })
    res.on('end', () => {
      activeRequests--

      if (res.statusCode >= 200 && res.statusCode <= 299) {
        callback(null, responseData, res.statusCode)
      } else {
        const error = new Error(`Error from the endpoint: ${res.statusCode} ${http.STATUS_CODES[res.statusCode]}`)
        error.status = res.statusCode

        callback(error, null, res.statusCode)
      }
    })
  }

  const makeRequest = onError => {
    if (!request.writable) {
      log.debug('Maximum number of active requests reached: payload is discarded.')
      return callback(null)
    }

    activeRequests++

    const store = storage.getStore()

    storage.enterWith({ noop: true })

    const req = client.request(options, onResponse)

    req.once('error', err => {
      activeRequests--
      onError(err)
    })

    req.setTimeout(timeout, req.abort)

    if (isReadable) {
      data.pipe(req) // TODO: Validate whether this is actually retriable.
    } else {
      dataArray.forEach(buffer => req.write(buffer))
      req.end()
    }

    storage.enterWith(store)
  }

  // TODO: Figure out why setTimeout is needed to avoid losing the async context
  // in the retry request before socket.connect() is called.
  // TODO: Test that this doesn't trace itself on retry when the diagnostics
  // channel events are available in the agent exporter.
  makeRequest(() => setTimeout(() => makeRequest(callback)))
}

function byteLength (data) {
  return data.length > 0 ? data.reduce((prev, next) => prev + next.length, 0) : 0
}

Object.defineProperty(request, 'writable', {
  get () {
    return activeRequests < maxActiveRequests
  }
})

module.exports = request
