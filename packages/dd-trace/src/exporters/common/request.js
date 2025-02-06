'use strict'

// TODO: Add test with slow or unresponsive agent.
// TODO: Add telemetry for things like dropped requests, errors, etc.

const { Readable } = require('stream')
const http = require('http')
const https = require('https')
const zlib = require('zlib')

const { urlToHttpOptions } = require('./url-to-http-options-polyfill')
const docker = require('./docker')
const { httpAgent, httpsAgent } = require('./agents')
const { storage } = require('../../../../datadog-core')
const log = require('../../log')

const maxActiveRequests = 8
const containerId = docker.id()

let activeRequests = 0

function parseUrl (urlObjOrString) {
  if (typeof urlObjOrString === 'object') return urlToHttpOptions(urlObjOrString)

  const url = urlToHttpOptions(new URL(urlObjOrString))

  // Special handling if we're using named pipes on Windows
  if (url.protocol === 'unix:' && url.hostname === '.') {
    const udsPath = urlObjOrString.slice(5)
    url.path = udsPath
    url.pathname = udsPath
  }

  return url
}

function request (data, options, callback) {
  if (!options.headers) {
    options.headers = {}
  }

  if (options.url) {
    const url = parseUrl(options.url)
    if (url.protocol === 'unix:') {
      options.socketPath = url.pathname
    } else {
      if (!options.path) options.path = url.path
      options.protocol = url.protocol
      options.hostname = url.hostname // for IPv6 this should be '::1' and not '[::1]'
      options.port = url.port
    }
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

  options.agent = isSecure ? httpsAgent : httpAgent

  const onResponse = res => {
    const chunks = []

    res.setTimeout(timeout)

    res.on('data', chunk => {
      chunks.push(chunk)
    })
    res.on('end', () => {
      activeRequests--
      const buffer = Buffer.concat(chunks)

      if (res.statusCode >= 200 && res.statusCode <= 299) {
        const isGzip = res.headers['content-encoding'] === 'gzip'
        if (isGzip) {
          zlib.gunzip(buffer, (err, result) => {
            if (err) {
              log.error('Could not gunzip response: %s', err.message)
              callback(null, '', res.statusCode)
            } else {
              callback(null, result.toString(), res.statusCode)
            }
          })
        } else {
          callback(null, buffer.toString(), res.statusCode)
        }
      } else {
        let errorMessage = ''
        try {
          const fullUrl = new URL(
            options.path,
            options.url || options.hostname || `http://localhost:${options.port}`
          ).href
          errorMessage = `Error from ${fullUrl}: ${res.statusCode} ${http.STATUS_CODES[res.statusCode]}.`
        } catch (e) {
          // ignore error
        }
        const responseData = buffer.toString()
        if (responseData) {
          errorMessage += ` Response from the endpoint: "${responseData}"`
        }
        const error = new Error(errorMessage)
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

    const store = storage('legacy').getStore()

    storage('legacy').enterWith({ noop: true })

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

    storage('legacy').enterWith(store)
  }

  // TODO: Figure out why setTimeout is needed to avoid losing the async context
  // in the retry request before socket.connect() is called.
  // TODO: Test that this doesn't trace itself on retry when the diagnostics
  // channel events are available in the agent exporter.
  makeRequest(() => setTimeout(() => makeRequest(callback)))
}

function byteLength (data) {
  return data.length > 0 ? data.reduce((prev, next) => prev + Buffer.byteLength(next, 'utf8'), 0) : 0
}

Object.defineProperty(request, 'writable', {
  get () {
    return activeRequests < maxActiveRequests
  }
})

module.exports = request
