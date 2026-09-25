'use strict'

const http = require('node:http')
const https = require('node:https')
const { Readable } = require('node:stream')

// Axios-compatible HTTP client test helper backed by Node's http/https modules — not `fetch` —
// so that using it doesn't (a) implicitly activate dd-trace's separate `fetch` instrumentation
// plugin, which auto-enables the moment `fetch()` is called and can interfere with tests that
// assert on which integrations/spans are active, and (b) require Node 18+, since the couchbase
// plugin's oldest supported version ranges are still tested against Node 16.

const MAX_REDIRECTS = 21

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !(
    Buffer.isBuffer(value) ||
    value instanceof Readable ||
    (typeof FormData !== 'undefined' && value instanceof FormData)
  )
}

function serializeBody (data, headers) {
  if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) {
    if (!('content-type' in headers) && !('Content-Type' in headers)) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
    return data.toString()
  }

  if (data === undefined || typeof data === 'string' || isPlainObject(data) === false) {
    return data
  }

  if (!('content-type' in headers) && !('Content-Type' in headers)) {
    headers['Content-Type'] = 'application/json'
  }

  return JSON.stringify(data)
}

// Reuses the Fetch API's own multipart/form-data boundary encoding (via a `Response` wrapping
// the FormData) rather than reimplementing it, since Node's http module has no built-in support
// for serializing FormData directly.
async function serializeFormData (formData) {
  const res = new Response(formData)
  const body = Buffer.from(await res.arrayBuffer())
  return { body, contentType: res.headers.get('content-type') }
}

function collectBody (res) {
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on('data', chunk => chunks.push(chunk))
    res.on('end', () => resolve(Buffer.concat(chunks)))
    res.on('error', reject)
  })
}

function parseBody (buffer, responseType) {
  switch (responseType) {
    case 'arraybuffer':
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    case 'text':
      return buffer.toString('utf8')
    default: {
      // Axios always attempts JSON.parse on the response text regardless of Content-Type,
      // silently falling back to the raw string if parsing throws (e.g. `res.send('3')` on
      // Express defaults to `text/html` but is still expected to parse as the number 3).
      const text = buffer.toString('utf8')
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
  }
}

function defaultValidateStatus (status) {
  return status >= 200 && status < 300
}

function handleResponse (res, config, url, redirectCount, resolve, reject) {
  const status = res.statusCode
  const location = res.headers.location

  if (status >= 300 && status < 400 && location && config.maxRedirects !== 0) {
    res.resume()
    if (redirectCount >= MAX_REDIRECTS) {
      reject(new Error('Maximum number of redirects exceeded'))
      return
    }
    const redirectUrl = new URL(location, url)
    request({ ...config, url: redirectUrl.href, baseURL: undefined, method: 'GET', data: undefined }, redirectCount + 1)
      .then(resolve, reject)
    return
  }

  if (config.responseType === 'stream') {
    finish(res, config, status, res)
    return
  }

  collectBody(res).then(buffer => {
    finish(res, config, status, parseBody(buffer, config.responseType))
  }, reject)

  function finish (rawRes, cfg, statusCode, data) {
    const response = {
      data,
      status: statusCode,
      statusText: rawRes.statusMessage,
      headers: { ...rawRes.headers },
      config: cfg,
    }

    // Axios treats an explicit falsy `validateStatus` (`null`/`false`) as "never reject",
    // distinct from not specifying it at all (`undefined`), so `??` alone would wrongly restore
    // the default.
    const validateStatus = cfg.validateStatus === undefined ? defaultValidateStatus : cfg.validateStatus
    if (validateStatus && !validateStatus(response.status)) {
      const err = new Error(`Request failed with status code ${response.status}`)
      err.response = response
      reject(err)
      return
    }

    resolve(response)
  }
}

function request (config, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    (async () => {
      const method = (config.method ?? 'GET').toUpperCase()
      const headers = { ...config.headers }

      let body
      if (method !== 'GET' && method !== 'HEAD') {
        if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
          const serialized = await serializeFormData(config.data)
          body = serialized.body
          if (!('content-type' in headers) && !('Content-Type' in headers)) {
            headers['Content-Type'] = serialized.contentType
          }
        } else {
          body = serializeBody(config.data, headers)
        }
      }

      if (config.auth) {
        const { username, password } = config.auth
        headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      }

      const url = new URL(config.url, config.baseURL)
      const isHttps = url.protocol === 'https:'
      const transport = isHttps ? https : http

      const options = { method, headers }
      const agent = isHttps ? config.httpsAgent : config.httpAgent
      if (agent) options.agent = agent
      if (config.signal) options.signal = config.signal

      const req = transport.request(url, options, res => {
        handleResponse(res, config, url, redirectCount, resolve, reject)
      })

      req.on('error', reject)

      if (config.timeout) {
        req.setTimeout(config.timeout, () => {
          req.destroy(new Error(`timeout of ${config.timeout}ms exceeded`))
        })
      }

      if (body && typeof body.pipe === 'function') {
        body.pipe(req)
      } else {
        req.end(body)
      }
    })().catch(reject)
  })
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
