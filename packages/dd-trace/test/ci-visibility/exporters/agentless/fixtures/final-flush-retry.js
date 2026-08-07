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
        const response = new EventEmitter()
        response.headers = {}
        response.statusCode = attempts === 1 ? 500 : 200
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
const BaseWriter = require('../../../../../src/exporters/common/writer')
const TestOptimizationRequestTracker = require(
  '../../../../../src/ci-visibility/exporters/agentless/request-tracker'
)

const writer = new BaseWriter({ url: 'http://localhost' })
const requestTracker = new TestOptimizationRequestTracker(writer)
let hasPayload = true
writer._encoder = {
  count: () => hasPayload ? 1 : 0,
  makePayload: () => {
    hasPayload = false
    return Buffer.from('payload')
  },
  reset: () => {},
}
writer._sendPayload = function (data, count, done, options) {
  requestTracker.send(request, data, { ...options, method: 'POST', path: '/', headers: {} }, done)
}
writer.flush = (done, options) => requestTracker.flush(done, options)

writer.flush()
writer.flush((error) => {
  process.stdout.write(error ? error.code : 'flushed')
}, { deadline: Date.now() + 1000 })
