'use strict'

const assert = require('node:assert')

const proxyquire = require('proxyquire')
const { describe, it } = require('tap').mocha

require('../setup/core')

describe('config/instrumentations', () => {
  const httpRequest = require('http').request
  const expressHandle = require('express').application.handle

  function getTracer() {
    const register = proxyquire.noPreserveCache()('../../../datadog-instrumentations/src/helpers/register', {})
    const instrumentations = proxyquire('../../../datadog-instrumentations/src/helpers/instrumentations', {
      './src/helpers/register': register
    })
    const pluginManager = proxyquire('../../src/plugin_manager', {
      '../../datadog-instrumentations': instrumentations
    })
    const proxy = proxyquire('../../src/proxy', {
      './plugin_manager': pluginManager
    })
    const TracerProxy = proxyquire('../../src', {
      './proxy': proxy
    })
    return proxyquire('../../', {
      './src': TracerProxy
    })
  }

  ['disable', 'enable'].forEach((mode) => {
    /** @type {(a: unknown, b: unknown) => void} */
    const assertionMethod = mode === 'disable' ? assert.strictEqual : assert.notStrictEqual

    describe(`config/${mode}_instrumentations`, () => {
      it(`should ${mode} node prefixed and unprefixed http instrumentations completely`, () => {
        if (mode === 'disable') {
          process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'http,express'
        }
        const tracer = getTracer()
        const prefixedHandleAfterImport = require('node:http').request
        const handleAfterImport = require('http').request
        tracer.init()
        const prefixedHandleAfterInit = require('http').request
        const handleAfterInit = require('http').request

        assertionMethod(httpRequest, handleAfterImport)
        assertionMethod(httpRequest, handleAfterInit)
        assertionMethod(httpRequest, prefixedHandleAfterImport)
        assertionMethod(httpRequest, prefixedHandleAfterInit)
        assert.strictEqual(handleAfterImport, handleAfterInit)
        assert.strictEqual(prefixedHandleAfterImport, prefixedHandleAfterInit)
        delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
      })

      it(`should ${mode} loading instrumentations completely`, () => {
        if (mode === 'disable') {
          process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'express'
        }
        const tracer = getTracer()
        // Ensure Express is reloaded through the instrumentation hook by clearing Node's require cache.
        delete require.cache[require.resolve('express')]
        // @ts-expect-error Express handle is not typed as it is an internal property
        const handleAfterImport = require('express').application.handle
        tracer.init()
        // Reload again post-init to validate behavior after tracer initialization.
        // @ts-expect-error Express handle is not typed as it is an internal property
        const handleAfterInit = require('express').application.handle

        assertionMethod(expressHandle, handleAfterImport)
        assertionMethod(expressHandle, handleAfterInit)
        delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
      })

      if (mode === 'disable') {
        it('should not disable loading instrumentations using DD_TRACE_<INTEGRATION>_ENABLED', () => {
          process.env.DD_TRACE_EXPRESS_ENABLED = 'false'
          const tracer = getTracer()
          delete require.cache[require.resolve('express')]
          // @ts-expect-error Express handle is not typed as it is an internal property
          const handleAfterImport = require('express').application.handle
          tracer.init()
          // @ts-expect-error Express handle is not typed as it is an internal property
          const handleAfterInit = require('express').application.handle

          assert.notStrictEqual(expressHandle, handleAfterImport)
          assert.notStrictEqual(expressHandle, handleAfterInit)
          assert.strictEqual(handleAfterImport, handleAfterInit)
          delete process.env.DD_TRACE_EXPRESS_ENABLED
        })
      }
    })
  })
})
