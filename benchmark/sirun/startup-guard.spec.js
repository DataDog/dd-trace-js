'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { describe, it, beforeEach, afterEach } = require('mocha')

describe('Sirun loop reporter', () => {
  let clock
  let operations
  let readyFd

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    operations = process.env.OPERATIONS
    readyFd = process.env.SIRUN_READY_FD
    process.env.OPERATIONS = '1'
    process.env.SIRUN_READY_FD = '3'
  })

  afterEach(() => {
    clock.restore()
    restoreEnv('OPERATIONS', operations)
    restoreEnv('SIRUN_READY_FD', readyFd)
  })

  it('does not enforce the legacy startup-share limit', () => {
    const reporter = loadReporter()

    clock.tick(1)
    reporter.loopStart()
    clock.tick(1)
    reporter.done(0)
  })

  it('requires loopStart before done', () => {
    const reporter = loadReporter()

    assert.throws(() => reporter.done(), /loopStart\(\) was never called/)
  })
})

function loadReporter () {
  class StatsD {
    gauge () {}
    flush () {}
  }

  const proxyquireWithoutCache = proxyquire.noPreserveCache()
  return proxyquireWithoutCache('./startup-guard', {
    './statsd': StatsD,
    fs: { writeSync () {} },
  })
}

/**
 * @param {string} name
 * @param {string|undefined} value
 */
function restoreEnv (name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
