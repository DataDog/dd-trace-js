'use strict'

const http = require('http')
const https = require('https')
const agents = require('./agents')
const semver = require('semver')
const containerInfo = require('container-info').sync() || {}

let undici
if (semver.satisfies(process.versions.node, '^10.16.0 || ^12.3.0 || ^14.0.0')) {
  try {
    undici = require('undici')
  } catch (_e) { /* */ }
}

const containerId = containerInfo.containerId
const pools = {}
let requestImpl

function request (options = {}, callback) {
  if (!options.headers) {
    options.headers = {}
  }
  if (!options.protocol) {
    options.protocol = 'http:'
  }
  if (!options.hostname) {
    options.hostname = 'localhost'
  }
  if (!options.port) {
    options.port = options.protocol === 'https:' ? 443 : 80
  }
  if (containerId) {
    options.headers['Datadog-Container-ID'] = containerId
  }
  return requestImpl.call(this, options, callback)
}

function bufArrify (data) {
  if (!data) return Buffer.alloc(0)
  if (data instanceof Buffer) return data
  if (Array.isArray(data)) {
    if (data.length === 1) return data[0]
    return Buffer.concat(data)
  }
}

function requestUndici (options, callback) {
  let cb = function (err, data, statusCode) {
    cb = () => undefined
    callback(err, data, statusCode)
  }

  let data = ''
  let rxStatusCode
  getPool(options).dispatch({
    path: options.path,
    method: options.method,
    headers: options.headers,
    body: bufArrify(options.data),
    requestTimeout: options.timeout || 2000
  }, {
    onConnect () {},
    onHeaders (statusCode) {
      if (statusCode < 200 || statusCode > 299) {
        const error = new Error(`Error from the agent: ${statusCode} ${http.STATUS_CODES[statusCode]}`)
        error.status = statusCode

        cb(error, null, statusCode)
      }
      rxStatusCode = statusCode
    },
    onData (chunk) {
      data += chunk
    },
    onComplete () {
      cb(null, data, rxStatusCode)
    },
    onError: e => {
      callback(new Error(`Network error trying to reach the agent: ${e.message}`))
    }
  })
}

function requestHttp (options, callback) {
  const platform = this

  options = Object.assign({
    headers: {},
    data: [],
    timeout: 2000
  }, options)

  const data = [].concat(options.data)
  const isSecure = options.protocol === 'https:'
  const { httpAgent, httpsAgent } = agents(platform._config)
  const client = isSecure ? https : http
  const agent = isSecure ? httpsAgent : httpAgent

  options.agent = agent
  options.headers['Content-Length'] = byteLength(data)

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
  req.on('error', e => callback(new Error(`Network error trying to reach the agent: ${e.message}`)))

  data.forEach(buffer => req.write(buffer))

  req.end()
}

function getPool (options) {
  const url = `${options.protocol}//${options.hostname}${options.port ? `:${options.port}` : ''}`
  let pool = pools[url]
  if (!pool) {
    pool = new undici.Pool(url)
  }
  return pool
}

function byteLength (data) {
  let len = 0
  for (const item of data) {
    len += item.length
  }
  return len
}

if (undici) {
  requestImpl = requestUndici
} else {
  requestImpl = requestHttp
}

module.exports = request
