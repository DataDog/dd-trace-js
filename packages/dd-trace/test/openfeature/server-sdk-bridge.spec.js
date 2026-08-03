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
    emitter.removeHandler(bridge.ProviderEvents.Ready, sinon.spy())
    emitter.removeAllHandlers(bridge.ProviderEvents.Ready)
    assert.deepStrictEqual(emitter.getHandlers(bridge.ProviderEvents.Ready), [])
    assert.strictEqual(emitter.setLogger({}), emitter)
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

  it('forwards removeHandler, removeAllHandlers, getHandlers, and setLogger to the real emitter', () => {
    const handlers = [sinon.spy()]
    const realEmitterInstance = {
      addHandler: sinon.spy(),
      emit: sinon.spy(),
      removeHandler: sinon.spy(),
      removeAllHandlers: sinon.spy(),
      getHandlers: sinon.stub().returns(handlers),
      setLogger: sinon.spy(),
    }
    const RealEventEmitter = sinon.stub().returns(realEmitterInstance)

    bridge.setEventEmitter(RealEventEmitter)

    const emitter = new bridge.OpenFeatureEventEmitter()
    const handler = sinon.spy()
    const logger = {}

    emitter.removeHandler('PROVIDER_READY', handler)
    emitter.removeAllHandlers('PROVIDER_READY')
    const result = emitter.getHandlers('PROVIDER_READY')
    const returned = emitter.setLogger(logger)

    sinon.assert.calledOnceWithExactly(realEmitterInstance.removeHandler, 'PROVIDER_READY', handler)
    sinon.assert.calledOnceWithExactly(realEmitterInstance.removeAllHandlers, 'PROVIDER_READY')
    sinon.assert.calledOnceWithExactly(realEmitterInstance.getHandlers, 'PROVIDER_READY')
    assert.strictEqual(result, handlers)
    sinon.assert.calledOnceWithExactly(realEmitterInstance.setLogger, logger)
    assert.strictEqual(returned, emitter)
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
