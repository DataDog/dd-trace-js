'use strict'

const http = require('http')
const { storage } = require('../../../../datadog-core')

function request (options, client, callback) {
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

module.exports = request
