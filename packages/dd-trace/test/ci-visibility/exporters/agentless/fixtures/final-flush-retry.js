'use strict'

const proxyquire = require('proxyquire')

let attempts = 0
const commonRequest = (data, options, callback) => {
  setImmediate(() => {
    attempts++
    if (attempts === 1) {
      const error = new Error('intake unavailable')
      error.status = 500
      callback(error, null, 500, {})
    } else {
      callback(null, '', 200, {})
    }
  })
}
commonRequest.writable = true

const request = proxyquire('../../../../../src/ci-visibility/exporters/request', {
  '../../exporters/common/request': commonRequest,
  '../../exporters/common/retry': {
    ...require('../../../../../src/exporters/common/retry'),
    getMaxAttempts: () => 2,
    getRetryDelay: () => 50,
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
