'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')

describe('thread-context benchmark preflight', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor)
  })

  it('fails clearly when the writer did not start', () => {
    const validateThreadContext = loadValidator({ metadata: undefined })

    assert.throws(() => validateThreadContext({}), {
      code: 'ERR_ASSERTION',
      message: 'thread-context writer did not start during benchmark preflight',
    })
  })

  it('wraps dependency load failures in a benchmark assertion', () => {
    const pprof = {}
    Object.defineProperty(pprof, 'otelThreadCtx', {
      get () { throw new Error('native module failed to load') },
    })
    const validateThreadContext = loadValidator({ metadata: {}, pprof })

    assert.throws(() => validateThreadContext({}), {
      code: 'ERR_ASSERTION',
      message: 'thread-context writer dependency failed to load during benchmark preflight: ' +
        'native module failed to load',
    })
  })
})

/**
 * @param {object} [options]
 * @param {object} [options.metadata]
 * @param {object} [options.pprof]
 */
function loadValidator ({ metadata, pprof = {} } = {}) {
  const load = proxyquire.noCallThru().noPreserveCache()
  return load('./validate-thread-context', {
    '../../packages/datadog-core/src/storage': { isACFActive: true },
    '../../packages/dd-trace/src/otel-thread-ctx': { getThreadLocalMetadata: () => metadata },
    '@datadog/pprof': pprof,
  })
}
