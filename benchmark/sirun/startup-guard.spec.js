'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')

const { describe, it, beforeEach, afterEach } = require('mocha')

describe('Sirun measurement boundary', () => {
  let gcDescriptor
  let readyFd
  let statsdPort

  beforeEach(() => {
    gcDescriptor = Object.getOwnPropertyDescriptor(global, 'gc')
    readyFd = process.env.SIRUN_READY_FD
    statsdPort = process.env.SIRUN_STATSD_PORT
    delete process.env.SIRUN_READY_FD
    delete process.env.SIRUN_STATSD_PORT
  })

  afterEach(() => {
    if (gcDescriptor) Object.defineProperty(global, 'gc', gcDescriptor)
    else delete global.gc
    restoreEnv('SIRUN_READY_FD', readyFd)
    restoreEnv('SIRUN_STATSD_PORT', statsdPort)
  })

  it('collects garbage before signaling readiness', () => {
    const calls = []
    global.gc = () => calls.push('gc')
    process.env.SIRUN_STATSD_PORT = '8125'
    process.env.SIRUN_READY_FD = '3'
    const boundary = loadBoundary(() => calls.push('ready'))

    boundary.loopStart()

    assert.deepStrictEqual(calls, ['gc', 'ready'])
  })

  it('requires readiness support from Sirun', () => {
    global.gc = () => {}
    process.env.SIRUN_STATSD_PORT = '8125'
    const boundary = loadBoundary(() => {})

    assert.throws(() => boundary.loopStart(), /SIRUN_READY_FD is required/)
  })

  it('requires exposed GC from the benchmark runner', () => {
    delete global.gc
    process.env.SIRUN_STATSD_PORT = '8125'
    process.env.SIRUN_READY_FD = '3'
    const boundary = loadBoundary(() => {})

    assert.throws(() => boundary.loopStart(), /--expose-gc/)
  })

  it('supports direct runs without a Sirun measurement boundary', () => {
    let collected = false
    global.gc = () => { collected = true }
    const boundary = loadBoundary(() => assert.fail('unexpected ready signal'))

    boundary.loopStart()

    assert.strictEqual(collected, true)
  })
})

/**
 * @param {() => void} writeSync
 */
function loadBoundary (writeSync) {
  const proxyquireWithoutCache = proxyquire.noPreserveCache()
  return proxyquireWithoutCache('./startup-guard', {
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
