'use strict'

const assert = require('node:assert/strict')
const dgram = require('node:dgram')

const sinon = require('sinon')

const createSocket = sinon.spy(dgram, 'createSocket')
const clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

try {
  const tracer = require('../../../ci/init')

  tracer.dogstatsd.increment('test.counter')
  tracer.dogstatsd.decrement('test.counter')
  tracer.dogstatsd.gauge('test.gauge', 1)
  tracer.dogstatsd.distribution('test.distribution', 1)
  tracer.dogstatsd.histogram('test.histogram', 1)
  tracer.dogstatsd.flush()
  clock.tick(10_000)

  assert.strictEqual(createSocket.callCount, 0, 'Test Optimization initialized a DogStatsD socket')
} finally {
  clock.restore()
  createSocket.restore()
}
