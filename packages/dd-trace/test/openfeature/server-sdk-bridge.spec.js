'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

require('../setup/core')

describe('OpenFeature server-sdk bridge', () => {
  let bridge

  beforeEach(() => {
    bridge = proxyquire('../../src/openfeature/server-sdk-bridge', {})
  })

  afterEach(() => {
    sinon.restore()
  })

  it('defaults ProviderEvents to an empty object', () => {
    assert.deepStrictEqual(bridge.ProviderEvents, {})
    assert.strictEqual(bridge.ProviderEvents.Ready, undefined)
  })

  it('constructs the deferred emitter without a real emitter registered', () => {
    const emitter = new bridge.OpenFeatureEventEmitter()

    emitter.addHandler(bridge.ProviderEvents.Ready, sinon.spy())
    emitter.emit(bridge.ProviderEvents.Ready)
  })

  it('forwards addHandler and emit to the real emitter once one is registered', () => {
    const realHandlers = new Map()
    const realEmitterInstance = {
      addHandler: sinon.spy((eventType, handler) => realHandlers.set(eventType, handler)),
      emit: sinon.spy((eventType, details) => realHandlers.get(eventType)?.(details)),
    }
    const RealEventEmitter = sinon.stub().returns(realEmitterInstance)

    bridge.setEventEmitter(RealEventEmitter)

    const emitter = new bridge.OpenFeatureEventEmitter()
    const handler = sinon.spy()

    emitter.addHandler('PROVIDER_READY', handler)
    emitter.emit('PROVIDER_READY', { some: 'details' })

    sinon.assert.calledOnce(RealEventEmitter)
    sinon.assert.calledOnceWithExactly(realEmitterInstance.addHandler, 'PROVIDER_READY', handler)
    sinon.assert.calledOnceWithExactly(handler, { some: 'details' })
  })

  it('reuses the same real emitter instance across calls on the same deferred emitter', () => {
    const realEmitterInstance = {
      addHandler: sinon.spy(),
      emit: sinon.spy(),
    }
    const RealEventEmitter = sinon.stub().returns(realEmitterInstance)

    bridge.setEventEmitter(RealEventEmitter)

    const emitter = new bridge.OpenFeatureEventEmitter()

    emitter.emit('PROVIDER_READY')
    emitter.addHandler('PROVIDER_READY', sinon.spy())

    sinon.assert.calledOnce(RealEventEmitter)
  })

  it('drops emits and handler registrations made before the real emitter is registered', () => {
    const emitter = new bridge.OpenFeatureEventEmitter()
    const handler = sinon.spy()

    emitter.addHandler('PROVIDER_READY', handler)
    emitter.emit('PROVIDER_READY')

    sinon.assert.notCalled(handler)

    const realEmitterInstance = {
      addHandler: sinon.spy(),
      emit: sinon.spy(),
    }
    bridge.setEventEmitter(sinon.stub().returns(realEmitterInstance))

    // Handlers registered before the real emitter existed are not retroactively replayed --
    // registration is only ever reachable through `@openfeature/server-sdk`, which by definition
    // cannot have run before it was itself loaded.
    emitter.emit('PROVIDER_READY')
    sinon.assert.notCalled(handler)
  })
})
