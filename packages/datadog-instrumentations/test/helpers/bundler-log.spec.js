'use strict'

const assert = require('node:assert/strict')
const { format } = require('node:util')

const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

describe('bundler loggers', () => {
  const originalDebug = process.env.DD_TRACE_DEBUG

  afterEach(() => {
    if (originalDebug === undefined) delete process.env.DD_TRACE_DEBUG
    else process.env.DD_TRACE_DEBUG = originalDebug
    sinon.restore()
  })

  for (const name of ['esbuild', 'vite', 'webpack']) {
    describe(name, () => {
      const entry = require.resolve(`../../../datadog-${name}/src/log`)

      it('keeps debug and warning output disabled unless debug logging is enabled', () => {
        const debug = sinon.stub(console, 'log')
        const warn = sinon.stub(console, 'warn')
        for (const value of [undefined, '', 'false', '0', 'other']) {
          if (value === undefined) delete process.env.DD_TRACE_DEBUG
          else process.env.DD_TRACE_DEBUG = value
          const log = proxyquire(entry, {})
          log.debug('hidden')
          log.warn('hidden')
        }
        sinon.assert.notCalled(debug)
        sinon.assert.notCalled(warn)
      })

      it('preserves its prefix and printf formatting for string and non-string messages', () => {
        const debug = sinon.stub(console, 'log')
        const warn = sinon.stub(console, 'warn')
        for (const value of ['true', '1', ' TRUE ', ' 1 ']) {
          process.env.DD_TRACE_DEBUG = value
          const log = proxyquire(entry, {})
          log.debug('module %s: %d', 'express', 2)
          log.warn('skipped %s', 'express')
          log.debug({ module: 'express' }, 2)
          log.warn()
        }
        assert.equal(debug.callCount, 8)
        assert.equal(warn.callCount, 8)
        assert.equal(debug.firstCall.args[0], `[dd-trace/${name}] module express: 2`)
        assert.equal(debug.secondCall.args[0], format(`[dd-trace/${name}]`, { module: 'express' }, 2))
        assert.equal(warn.firstCall.args[0], `[dd-trace/${name}] Warning: skipped express`)
        assert.equal(warn.secondCall.args[0], `[dd-trace/${name}] Warning: undefined`)
      })

      it('snapshots debug configuration independently when each wrapper is loaded', () => {
        const debug = sinon.stub(console, 'log')
        process.env.DD_TRACE_DEBUG = 'false'
        const disabled = proxyquire(entry, {})
        process.env.DD_TRACE_DEBUG = 'true'
        const enabled = proxyquire(entry, {})
        process.env.DD_TRACE_DEBUG = 'false'

        disabled.debug('hidden')
        enabled.debug('visible')

        sinon.assert.calledOnceWithExactly(debug, `[dd-trace/${name}] visible`)
      })
    })
  }
})
