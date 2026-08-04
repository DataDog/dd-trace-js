'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()

describe('otel-azure-durable-functions', () => {
  function loadWithEnabled (enabled) {
    const capturedTransforms = []
    proxyquire('../../src/otel-azure-durable-functions', {
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

  it('wraps orchestration, activity, and entity registration methods', () => {
    const { capturedTransforms } = loadWithEnabled(true)
    const app = {
      entity (name, arg) { return arg },
      activity (name, options) { return options },
      orchestration (name, handler) { return handler },
    }

    capturedTransforms[0]({ app })

    assert.notEqual(app.entity, undefined)
    assert.notEqual(app.activity, undefined)
    assert.notEqual(app.orchestration, undefined)
  })
})
