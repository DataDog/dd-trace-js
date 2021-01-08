'use strict'

const undici = require('undici')
const { STATUS_CODES } = require('http')
const { Readable } = require('stream')
const pools = {}

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
        const error = new Error(`Error from the agent: ${statusCode} ${STATUS_CODES[statusCode]}`)
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

function getPool (options) {
  const url = `${options.protocol}//${options.hostname}${options.port ? `:${options.port}` : ''}`
  let pool = pools[url]
  if (!pool) {
    pool = new undici.Pool(url)
  }
  return pool
}

function bufArrify (data) {
  if (!data) return Buffer.alloc(0)
  if (data instanceof Buffer) return data
  if (Array.isArray(data)) {
    if (data.length === 1) return bufArrify(data[0])
    const strm = new Readable()
    for (const chunk of data) {
      strm.push(chunk)
    }
    strm.push(null)
    return strm
  }
}

module.exports = requestUndici
