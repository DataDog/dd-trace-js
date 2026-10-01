'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')

const { describe, it, beforeEach, afterEach } = require('mocha')

describe('Sirun loop reporter', () => {
  let gcDescriptor
  let operations
  let readyFd
  let statsdPort

  beforeEach(() => {
    gcDescriptor = Object.getOwnPropertyDescriptor(global, 'gc')
    operations = process.env.OPERATIONS
    readyFd = process.env.SIRUN_READY_FD
    statsdPort = process.env.SIRUN_STATSD_PORT
    process.env.OPERATIONS = '1'
    delete process.env.SIRUN_READY_FD
    delete process.env.SIRUN_STATSD_PORT
  })

  afterEach(() => {
    if (gcDescriptor) Object.defineProperty(global, 'gc', gcDescriptor)
    else delete global.gc
    restoreEnv('OPERATIONS', operations)
    restoreEnv('SIRUN_READY_FD', readyFd)
    restoreEnv('SIRUN_STATSD_PORT', statsdPort)
  })

  it('does not enforce the legacy startup-share limit', () => {
    process.env.SIRUN_READY_FD = '3'
    const reporter = loadReporter()

    reporter.loopStart()
    reporter.done(0)
  })

  it('requires loopStart before done', () => {
    const reporter = loadReporter()

    assert.throws(() => reporter.done(), /loopStart\(\) was never called/)
  })

  it('collects garbage before signaling readiness', () => {
    const calls = []
    global.gc = () => calls.push('gc')
    process.env.SIRUN_STATSD_PORT = '8125'
    process.env.SIRUN_READY_FD = '3'
    const boundary = loadReporter(() => calls.push('ready'))

    boundary.loopStart()

    assert.deepStrictEqual(calls, ['gc', 'ready'])
  })

  it('requires readiness support from Sirun', () => {
    global.gc = () => {}
    process.env.SIRUN_STATSD_PORT = '8125'
    const boundary = loadReporter()

    assert.throws(() => boundary.loopStart(), /SIRUN_READY_FD is required/)
  })

  it('requires exposed GC from the benchmark runner', () => {
    delete global.gc
    process.env.SIRUN_STATSD_PORT = '8125'
    process.env.SIRUN_READY_FD = '3'
    const boundary = loadReporter()

    assert.throws(() => boundary.loopStart(), /--expose-gc/)
  })
})

/**
 * @param {() => void} [writeSync]
 */
function loadReporter (writeSync = () => {}) {
  class StatsD {
    gauge () {}
    flush () {}
  }

  const proxyquireWithoutCache = proxyquire.noPreserveCache()
  return proxyquireWithoutCache('./startup-guard', {
    './statsd': StatsD,
    'node:fs': { writeSync },
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
