'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()

describe('openfeature-server-sdk', () => {
  it('captures the emitter and events into the bridge and returns the exports unchanged', () => {
    let capturedName
    let capturedTransform
    let capturedEventEmitter
    const bridge = {
      setEventEmitter: (EventEmitter) => {
        capturedEventEmitter = EventEmitter
      },
    }

    proxyquire('../src/openfeature-server-sdk', {
      './helpers/instrument': {
        addHook: (options, transform) => {
          capturedName = options.name
          capturedTransform = transform
        },
      },
      '../../dd-trace/src/openfeature/server-sdk-bridge': bridge,
    })

    assert.equal(capturedName, '@openfeature/server-sdk')

    const moduleExports = { OpenFeatureEventEmitter: class {}, ProviderEvents: { Ready: 'READY' } }
    const result = capturedTransform(moduleExports)

    assert.equal(result, moduleExports)
    assert.equal(capturedEventEmitter, moduleExports.OpenFeatureEventEmitter)
    assert.equal(bridge.ProviderEvents, moduleExports.ProviderEvents)
  })
})
