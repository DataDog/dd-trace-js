'use strict'

const { EventEmitter } = require('node:events')

const proxyquire = require('proxyquire')

let attempts = 0
const http = {
  request (options, onResponse) {
    const outgoing = new EventEmitter()
    outgoing.setTimeout = () => {}
    outgoing.write = () => {}
    outgoing.end = () => {
      setImmediate(() => {
        attempts++
        if (attempts === 1) {
          const error = new Error('socket closed')
          error.code = 'ECONNRESET'
          outgoing.emit('error', error)
          return
        }

        const response = new EventEmitter()
        response.headers = {}
        response.statusCode = 200
        response.setTimeout = () => {}
        onResponse(response)
        response.emit('end')
      })
    }
    return outgoing
  },
  STATUS_CODES: {},
}

const request = proxyquire('../../../../../src/exporters/common/request', {
  http,
  './retry': {
    ...require('../../../../../src/exporters/common/retry'),
    getMaxAttempts: () => 2,
    getRetryDelay: () => 50,
    markEndpointReached: () => {},
  },
})
const TestOptimizationWriter = require('../../../../../src/ci-visibility/exporters/agentless/base-writer')

const writer = new TestOptimizationWriter({ url: 'http://localhost' })
writer._encoder = {
  count: () => 1,
  makePayload: () => Buffer.from('payload'),
  reset: () => {},
}
writer._sendPayload = function (data, count, done, options) {
  this._sendRequest(request, data, { ...options, method: 'POST', path: '/', headers: {} }, done)
}

writer.flush((error) => {
  process.stdout.write(error ? error.code : 'flushed')
}, { deadline: Date.now() + 1000 })
