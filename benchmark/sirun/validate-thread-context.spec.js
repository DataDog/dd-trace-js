'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')

describe('thread-context benchmark preflight', () => {
  const enabled = process.env.DD_TRACE_OTEL_CTX_ENABLED
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    process.env.DD_TRACE_OTEL_CTX_ENABLED = 'true'
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  })

  afterEach(() => {
    if (enabled === undefined) {
      delete process.env.DD_TRACE_OTEL_CTX_ENABLED
    } else {
      process.env.DD_TRACE_OTEL_CTX_ENABLED = enabled
    }
    Object.defineProperty(process, 'platform', platformDescriptor)
  })

  it('does nothing when thread context is disabled or unset', () => {
    const validateThreadContext = loadValidator()

    delete process.env.DD_TRACE_OTEL_CTX_ENABLED
    validateThreadContext({})

    process.env.DD_TRACE_OTEL_CTX_ENABLED = 'false'
    validateThreadContext({})
  })

  it('does nothing outside Linux', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    const validateThreadContext = loadValidator()

    validateThreadContext({})
  })

  it('does nothing when AsyncContextFrame is inactive', () => {
    const validateThreadContext = loadValidator({ isACFActive: false })

    validateThreadContext({})
  })

  for (const value of ['true', '1']) {
    it(`validates an active thread context when enabled with ${value}`, () => {
      process.env.DD_TRACE_OTEL_CTX_ENABLED = value
      const validateThreadContext = loadValidator()
      const { state, tracer } = createTracer()

      validateThreadContext(tracer)

      assert.deepEqual(state, { activated: true, finished: true, started: true })
    })
  }

  it('fails clearly when the writer did not start', () => {
    const validateThreadContext = loadValidator({ metadata: undefined })

    assert.throws(() => validateThreadContext({}), {
      code: 'ERR_ASSERTION',
      message: 'thread-context writer did not start during benchmark preflight',
    })
  })

  it('fails clearly when the writer does not install an active context', () => {
    const validateThreadContext = loadValidator({ getContext: () => undefined })
    const { tracer } = createTracer()

    assert.throws(() => validateThreadContext(tracer), {
      code: 'ERR_ASSERTION',
      message: 'thread-context writer did not install a thread context during benchmark preflight',
    })
  })
})

/**
 * @param {object} [options]
 * @param {() => object | undefined} [options.getContext]
 * @param {boolean} [options.isACFActive]
 * @param {object | undefined} [options.metadata]
 */
function loadValidator (options = {}) {
  const { getContext = () => ({}), isACFActive = true } = options
  const metadata = Object.hasOwn(options, 'metadata') ? options.metadata : {}
  const load = proxyquire.noCallThru().noPreserveCache()
  return load('./validate-thread-context', {
    '../../packages/datadog-core/src/storage': { isACFActive },
    '../../packages/dd-trace/src/otel-thread-ctx': { getThreadLocalMetadata: () => metadata },
    '@datadog/pprof': { otelThreadCtx: { getContext } },
  })
}

function createTracer () {
  const state = { activated: false, finished: false, started: false }
  const span = {
    finish () {
      state.finished = true
    },
  }
  const tracer = {
    scope () {
      return {
        activate (activeSpan, callback) {
          assert.equal(activeSpan, span)
          state.activated = true
          callback()
        },
      }
    },
    startSpan (name) {
      assert.equal(name, 'sirun.thread-context.preflight')
      state.started = true
      return span
    },
  }
  return { state, tracer }
}
