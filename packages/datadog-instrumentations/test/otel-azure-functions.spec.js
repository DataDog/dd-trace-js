'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()

describe('otel-azure-functions', () => {
  function loadWithEnabled (enabled) {
    const capturedTransforms = []
    proxyquire('../../src/otel-azure-functions', {
      './helpers/otel-azure-enabled': {
        isOtelAzureInstrumentationEnabled: () => enabled,
      },
      './helpers/instrument': {
        addHook: (_options, transform) => capturedTransforms.push(transform),
      },
    })
    return { capturedTransforms }
  }

  it('registers hooks when OTel azure instrumentation is enabled', () => {
    const { capturedTransforms } = loadWithEnabled(true)
    assert.equal(capturedTransforms.length, 1)
  })

  it('does not register hooks when OTel azure instrumentation is disabled', () => {
    const { capturedTransforms } = loadWithEnabled(false)
    assert.equal(capturedTransforms.length, 0)
  })

  it('wraps HTTP and generic registration methods', () => {
    const { capturedTransforms } = loadWithEnabled(true)
    const app = {
      http (name, arg) { return arg },
      generic (name, options) { return options },
    }

    capturedTransforms[0]({ app })

    assert.notEqual(app.http, undefined)
    assert.notEqual(app.generic, undefined)
  })
})
