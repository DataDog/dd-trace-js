'use strict'

const { Readable } = require('stream')

// axios-compatible HTTP client test helper backed by native `fetch`
// provides a subset of functionality based on what the test suite uses

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !(
    value instanceof FormData ||
    value instanceof Buffer ||
    value instanceof Readable ||
    value instanceof ReadableStream ||
    value instanceof ArrayBuffer ||
    value instanceof URLSearchParams
  )
}

function serializeBody (data, headers) {
  if (data === undefined || typeof data === 'string' || isPlainObject(data) === false) {
    return data
  }

  if (!('content-type' in headers) && !('Content-Type' in headers)) {
    headers['Content-Type'] = 'application/json'
  }

  return JSON.stringify(data)
}

function headersToObject (fetchHeaders) {
  const headers = {}

  for (const [key, value] of fetchHeaders.entries()) {
    headers[key] = value
  }

  return headers
}

async function parseResponseBody (res, responseType) {
  switch (responseType) {
    case 'arraybuffer':
      return res.arrayBuffer()
    case 'text':
      return res.text()
    case 'stream':
      return Readable.fromWeb(res.body)
    default: {
      const text = await res.text()
      const contentType = res.headers.get('content-type') ?? ''

      if (text && contentType.includes('json')) {
        return JSON.parse(text)
      }

      return text
    }
  }
}

function defaultValidateStatus (status) {
  return status >= 200 && status < 300
}

async function request (config) {
  const method = (config.method ?? 'GET').toUpperCase()
  // Unlike axios (backed by Node's http.Agent, which defaults to keepAlive: false), undici's
  // fetch() pools and reuses connections by default. Test servers routinely restart on a port a
  // prior test already used, and a pooled connection surviving that restart causes late-firing
  // 'close' events to leak into a later test's execution window. Forcing the connection closed
  // per-request avoids that class of cross-test timing bug.
  const headers = { Connection: 'close', ...config.headers }
  // fetch forbids a body on GET/HEAD requests, even a present-but-empty stream, so it must be
  // omitted entirely rather than merely left unserialized.
  const body = method === 'GET' || method === 'HEAD' ? undefined : serializeBody(config.data, headers)

  if (config.auth) {
    const { username, password } = config.auth
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  }

  const url = config.baseURL ? new URL(config.url, config.baseURL) : config.url

  // `AbortSignal.any` (Node 20.3+) isn't used here since no call site combines `signal` and
  // `timeout` together, and this helper must stay compatible with Node 18.
  const signal = config.signal ?? (config.timeout ? AbortSignal.timeout(config.timeout) : undefined)

  const res = await fetch(url, {
    method,
    headers,
    body,
    // Required by undici/fetch when streaming a Node/web stream as the request body.
    duplex: body instanceof Readable || body instanceof ReadableStream ? 'half' : undefined,
    redirect: config.maxRedirects === 0 ? 'manual' : 'follow',
    signal,
  })

  const data = await parseResponseBody(res, config.responseType)

  const response = {
    data,
    status: res.status,
    statusText: res.statusText,
    headers: headersToObject(res.headers),
    config,
  }

  // Axios treats an explicit falsy `validateStatus` (`null`/`false`) as "never reject", distinct
  // from not specifying it at all (`undefined`), so `??` alone would wrongly restore the default.
  const validateStatus = config.validateStatus === undefined ? defaultValidateStatus : config.validateStatus
  if (validateStatus && !validateStatus(response.status)) {
    const err = new Error(`Request failed with status code ${response.status}`)
    err.response = response
    throw err
  }

  return response
}

function normalizeConfig (urlOrConfig, dataOrConfig, maybeConfig, method) {
  if (typeof urlOrConfig !== 'string') {
    return { ...urlOrConfig, method: urlOrConfig.method ?? method }
  }

  if (method === 'GET' || method === 'DELETE') {
    return { ...dataOrConfig, url: urlOrConfig, method }
  }

  return { ...maybeConfig, url: urlOrConfig, data: dataOrConfig, method }
}

function createInstance (defaults = {}) {
  function instance (urlOrConfig, dataOrConfig, maybeConfig) {
    const config = { ...defaults, ...normalizeConfig(urlOrConfig, dataOrConfig, maybeConfig, defaults.method) }
    config.headers = { ...defaults.headers, ...config.headers }
    return request(config)
  }

  for (const method of ['get', 'delete']) {
    instance[method] = (url, config) => {
      const merged = { ...defaults, ...normalizeConfig(url, config, undefined, method.toUpperCase()) }
      merged.headers = { ...defaults.headers, ...merged.headers }
      return request(merged)
    }
  }

  for (const method of ['post', 'put', 'patch']) {
    instance[method] = (url, data, config) => {
      const merged = { ...defaults, ...normalizeConfig(url, data, config, method.toUpperCase()) }
      merged.headers = { ...defaults.headers, ...merged.headers }
      return request(merged)
    }
  }

  // `axios.request(url, config)` / `axios.request(config)`: unlike the callable instance form,
  // the second argument here is always a config, never a data body.
  instance.request = (urlOrConfig, config) => {
    const merged = typeof urlOrConfig === 'string'
      ? { ...defaults, ...config, url: urlOrConfig }
      : { ...defaults, ...urlOrConfig }
    merged.headers = { ...defaults.headers, ...merged.headers }
    return request(merged)
  }

  instance.create = (config = {}) => createInstance({ ...defaults, ...config })

  return instance
}

module.exports = createInstance()
