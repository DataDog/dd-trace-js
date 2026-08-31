'use strict'

const http = require('node:http')
const https = require('node:https')

const { storage } = require('../../../../datadog-core')
const log = require('../../log')
const { markEndpointReached } = require('../../exporters/common/retry')
const { isLoopbackHost, parseUrl } = require('../../exporters/common/url')

const legacyStorage = storage('legacy')
const MAX_ACTIVE_REQUESTS = 16

let activeRequests = 0

/**
 * Streams one video request attempt. Test Optimization retry policy stays in the exporter request wrapper.
 *
 * @param {import('node:stream').Readable} body - Video stream for this attempt
 * @param {object} options - HTTP request options
 * @param {(error: Error|null, result?: string|null, statusCode?: number,
 *   headers?: import('node:http').IncomingHttpHeaders) => void} callback
 * @returns {void}
 */
function requestVideo (body, options, callback) {
  if (activeRequests >= MAX_ACTIVE_REQUESTS) {
    if (!body.destroyed) body.destroy()
    const error = new log.NoTransmitError('Maximum active video request count reached.')
    error.code = 'ERR_DD_VIDEO_REQUEST_LIMIT'
    callback(error)
    return
  }

  let requestOptions
  try {
    requestOptions = getRequestOptions(options)
  } catch (error) {
    if (!body.destroyed) body.destroy()
    callback(error)
    return
  }

  activeRequests++
  legacyStorage.run({ noop: true }, () => {
    const timeout = options.timeout || 2000
    const client = requestOptions.protocol === 'https:' ? https : http
    let finished = false
    let req = null

    const complete = (error, result, statusCode, headers) => {
      if (finished) return
      finished = true
      activeRequests--
      options.signal?.removeEventListener('abort', onAbort)
      body.unpipe(req)
      if (!body.destroyed) body.destroy()
      if (req && !req.destroyed && (error || !req.writableFinished)) req.destroy()
      callback(error, result, statusCode, headers)
    }
    const onAbort = () => complete(getAbortError(options.signal))

    try {
      req = client.request(requestOptions, res => {
        markEndpointReached(requestOptions)
        const chunks = []

        res.setTimeout(timeout)
        res.on('data', chunk => chunks.push(chunk))
        res.once('aborted', () => complete(Object.assign(new Error('Response aborted'), { code: 'ECONNRESET' })))
        res.once('error', complete)
        res.once('timeout', () => complete(Object.assign(new Error('Response timed out'), { code: 'ETIMEDOUT' })))
        res.once('end', () => {
          const result = Buffer.concat(chunks).toString()
          if (res.statusCode >= 200 && res.statusCode <= 299) {
            complete(null, result, res.statusCode, res.headers)
          } else {
            complete(buildError(res, result, requestOptions), null, res.statusCode, res.headers)
          }
        })
      })
    } catch (error) {
      activeRequests--
      if (!body.destroyed) body.destroy()
      callback(error)
      return
    }

    req.once('error', complete)
    req.setTimeout(timeout, () => complete(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })))
    body.once('error', error => {
      error.retryable = false
      complete(error)
    })
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) return onAbort()
    body.pipe(req)
  })
}

/**
 * @param {object} options
 * @returns {object}
 */
function getRequestOptions (options) {
  const requestOptions = {
    ...options,
    headers: options.headers ? { ...options.headers } : {},
  }

  if (options.url) {
    const url = parseUrl(options.url)
    if (url.protocol === 'unix:') {
      requestOptions.socketPath = url.pathname
    } else {
      requestOptions.protocol = url.protocol
      requestOptions.hostname = url.hostname
      requestOptions.port = url.port
      requestOptions.path ??= url.path
    }
  }

  const hasApiKey = requestOptions.headers['dd-api-key'] !== undefined ||
    requestOptions.headers['DD-API-KEY'] !== undefined
  if (hasApiKey && requestOptions.protocol === 'http:' && !isLoopbackHost(requestOptions.hostname)) {
    log.error(
      'Not sending the Datadog API key over a non-TLS connection to %s. Configure an https intake URL.',
      requestOptions.hostname
    )
    delete requestOptions.headers['dd-api-key']
    delete requestOptions.headers['DD-API-KEY']
  }

  delete requestOptions.deadline
  delete requestOptions.retry
  delete requestOptions.retryUntilDeadline
  delete requestOptions.signal
  delete requestOptions.url
  return requestOptions
}

/**
 * @param {AbortSignal} signal
 * @returns {Error}
 */
function getAbortError (signal) {
  return signal?.reason || Object.assign(new Error('Request aborted'), { code: 'ABORT_ERR' })
}

/**
 * @param {import('node:http').IncomingMessage} res
 * @param {string} responseData
 * @param {object} options
 * @returns {Error}
 */
function buildError (res, responseData, options) {
  let errorMessage = ''
  try {
    const port = options.port ? `:${options.port}` : ''
    const baseUrl = `${options.protocol || 'http:'}//${options.hostname || 'localhost'}${port}`
    const fullUrl = new URL(options.path, baseUrl).href
    errorMessage = `Error from ${fullUrl}: ${res.statusCode} ${http.STATUS_CODES[res.statusCode]}.`
  } catch {
    // ignore
  }
  if (responseData) errorMessage += ` Response from the endpoint: "${responseData}"`

  const error = new log.NoTransmitError(errorMessage)
  error.status = res.statusCode
  return error
}

Object.defineProperty(requestVideo, 'writable', {
  get () { return activeRequests < MAX_ACTIVE_REQUESTS },
})

module.exports = requestVideo
