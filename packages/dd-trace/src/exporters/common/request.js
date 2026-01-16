'use strict'

// TODO: Add telemetry for things like dropped requests, errors, etc.

const { Readable } = require('stream')
const http = require('http')
const https = require('https')
const zlib = require('zlib')

const { storage } = require('../../../../datadog-core')
const log = require('../../log')
const { urlToHttpOptions } = require('./url-to-http-options-polyfill')
const docker = require('./docker')
const { httpAgent, httpsAgent } = require('./agents')

const maxActiveRequestsPerEndpoint = 8
const activeRequestsByEndpoint = new Map()
const activeRequestsByUrl = new Map()

function stripQueryAndHash (path) {
  if (!path) return '/'

  const queryIndex = path.indexOf('?')
  const hashIndex = path.indexOf('#')

  let endIndex = path.length
  if (queryIndex !== -1) endIndex = Math.min(endIndex, queryIndex)
  if (hashIndex !== -1) endIndex = Math.min(endIndex, hashIndex)

  const stripped = path.slice(0, endIndex)
  return stripped || '/'
}

function formatHostname (hostname) {
  if (!hostname) return 'localhost'
  // Wrap IPv6 literals in brackets for stable endpoint keys.
  if (hostname.includes(':') && !hostname.startsWith('[') && !hostname.endsWith(']')) {
    return `[${hostname}]`
  }
  return hostname
}

function getUrlKeyFromOptions (options) {
  if (options.socketPath) {
    return `unix:${options.socketPath}`
  }

  const protocol = options.protocol || 'http:'
  const { hostname: hostFromHost, port: portFromHost } = parseHostAndPort(options.host)

  const hostname = options.hostname || hostFromHost || 'localhost'
  const port = options.port || portFromHost || (protocol === 'https:' ? 443 : 80)

  return `${protocol}//${formatHostname(hostname)}:${String(port)}`
}

function getUrlKey (urlObjOrString) {
  if (!urlObjOrString) return ''

  const url = parseUrl(urlObjOrString)
  if (url.protocol === 'unix:') {
    return `unix:${url.pathname}`
  }

  const protocol = url.protocol || 'http:'
  const hostname = url.hostname || 'localhost'
  const port = url.port || (protocol === 'https:' ? 443 : 80)

  return `${protocol}//${formatHostname(hostname)}:${String(port)}`
}

function parseHostAndPort (host) {
  if (!host) return {}

  // IPv6 like "[::1]:8126"
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end !== -1) {
      const hostname = host.slice(1, end)
      const rest = host.slice(end + 1)
      if (rest.startsWith(':')) return { hostname, port: rest.slice(1) }
      return { hostname }
    }
  }

  const idx = host.lastIndexOf(':')
  if (idx !== -1 && host.indexOf(':') === idx) {
    return { hostname: host.slice(0, idx), port: host.slice(idx + 1) }
  }

  return { hostname: host }
}

function getEndpointKey (options) {
  const path = stripQueryAndHash(options.path)

  if (options.socketPath) {
    // Unix domain sockets and Windows named pipes are both expressed as socketPath in Node.
    return `unix:${options.socketPath}${path}`
  }

  const protocol = options.protocol || 'http:'
  const { hostname: hostFromHost, port: portFromHost } = parseHostAndPort(options.host)

  const hostname = options.hostname || hostFromHost || 'localhost'
  const port = options.port || portFromHost || (protocol === 'https:' ? 443 : 80)

  return `${protocol}//${formatHostname(hostname)}:${String(port)}${path}`
}

function canStartRequestForEndpoint (endpointKey) {
  const count = activeRequestsByEndpoint.get(endpointKey) || 0
  return count < maxActiveRequestsPerEndpoint
}

function incrementEndpoint (endpointKey) {
  const count = activeRequestsByEndpoint.get(endpointKey) || 0
  activeRequestsByEndpoint.set(endpointKey, count + 1)
}

function decrementEndpoint (endpointKey) {
  const count = activeRequestsByEndpoint.get(endpointKey)
  if (!count) return

  if (count <= 1) {
    activeRequestsByEndpoint.delete(endpointKey)
  } else {
    activeRequestsByEndpoint.set(endpointKey, count - 1)
  }
}

function incrementUrl (urlKey) {
  const count = activeRequestsByUrl.get(urlKey) || 0
  activeRequestsByUrl.set(urlKey, count + 1)
}

function decrementUrl (urlKey) {
  const count = activeRequestsByUrl.get(urlKey)
  if (!count) return

  if (count <= 1) {
    activeRequestsByUrl.delete(urlKey)
  } else {
    activeRequestsByUrl.set(urlKey, count - 1)
  }
}

function parseUrl (urlObjOrString) {
  if (urlObjOrString !== null && typeof urlObjOrString === 'object') return urlToHttpOptions(urlObjOrString)

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
  if (!options.path) options.path = '/'

  // The timeout should be kept low to avoid excessive queueing.
  const timeout = options.timeout || 2000
  const isSecure = options.protocol === 'https:'
  const client = isSecure ? https : http
  let dataArray = data

  if (!isReadable) {
    if (!Array.isArray(data)) {
      dataArray = [data]
    }
    options.headers['Content-Length'] = byteLength(dataArray)
  }

  docker.inject(options.headers)

  options.agent = isSecure ? httpsAgent : httpAgent

  const makeRequest = onError => {
    const endpointKey = getEndpointKey(options)
    if (!canStartRequestForEndpoint(endpointKey)) {
      log.debug('Maximum number of active requests reached for endpoint %s. Payload discarded.', endpointKey)
      return callback(null)
    }

    const urlKey = getUrlKeyFromOptions(options)
    incrementEndpoint(endpointKey)
    incrementUrl(urlKey)
    let finished = false
    const finishOnce = () => {
      if (finished) return
      finished = true
      decrementEndpoint(endpointKey)
      decrementUrl(urlKey)
    }

    const store = storage('legacy').getStore()

    storage('legacy').enterWith({ noop: true })

    const onResponse = res => {
      const chunks = []

      res.setTimeout(timeout)

      res.on('data', chunk => {
        chunks.push(chunk)
      })
      res.on('close', () => {
        finishOnce()
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
          } catch {
            // ignore error
          }

          const responseData = buffer.toString()
          if (responseData) {
            errorMessage += ` Response from the endpoint: "${responseData}"`
          }
          const error = new log.NoTransmitError(errorMessage)
          error.status = res.statusCode

          callback(error, null, res.statusCode)
        }
      })
    }

    const req = client.request(options, onResponse)

    req.once('error', err => {
      finishOnce()
      onError(err)
    })

    req.setTimeout(timeout, () => {
      req.destroy()
    })

    req.once('close', finishOnce)

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

request.isUrlWritable = (urlObjOrString) => {
  const urlKey = getUrlKey(urlObjOrString)
  if (!urlKey) return true

  const count = activeRequestsByUrl.get(urlKey) || 0
  return count < maxActiveRequestsPerEndpoint
}

module.exports = request
