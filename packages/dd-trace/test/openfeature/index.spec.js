'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const { channel } = require('dc-polyfill')

require('../setup/core')

describe('OpenFeature Module', () => {
  let config
  let openfeatureModule
  let mockWriter
  let ExposuresWriterStub
  let setAgentStrategyStub
  let log

  beforeEach(() => {
    config = {
      ffeFlushInterval: 1000,
      ffeTimeout: 5000,
    }

    mockWriter = {
      append: sinon.spy(),
      flush: sinon.spy(),
      destroy: sinon.spy(),
      setEnabled: sinon.spy(),
    }

    ExposuresWriterStub = sinon.stub().returns(mockWriter)
    setAgentStrategyStub = sinon.stub()
    log = {
      debug: sinon.spy(),
      error: sinon.spy(),
      warn: sinon.spy(),
    }

    openfeatureModule = proxyquire('../../src/openfeature', {
      '../log': log,
      './writers/exposures': ExposuresWriterStub,
      './writers/util': { setAgentStrategy: setAgentStrategyStub },
    })
  })

  afterEach(() => {
    openfeatureModule.disable()
  })

  describe('enable/disable', () => {
    it('should export enable and disable functions', () => {
      assert.strictEqual(typeof openfeatureModule.enable, 'function')
      assert.strictEqual(typeof openfeatureModule.disable, 'function')
    })

    it('should setup writer when enabled', () => {
      openfeatureModule.enable(config)

      sinon.assert.calledOnceWithExactly(ExposuresWriterStub, config)
      sinon.assert.calledOnce(setAgentStrategyStub)
    })

    it('should enable direct exposure delivery in agentless mode', () => {
      config.DD_AGENTLESS_ENABLED = true
      openfeatureModule.enable(config)

      sinon.assert.calledOnceWithExactly(ExposuresWriterStub, config)
      sinon.assert.calledOnceWithExactly(mockWriter.setEnabled, true)
      sinon.assert.notCalled(setAgentStrategyStub)
    })

    it('should not enable exposure delivery when its writer configuration is invalid', () => {
      ExposuresWriterStub.throws(new Error('invalid direct intake'))

      openfeatureModule.enable(config)

      sinon.assert.calledOnceWithExactly(
        log.error,
        'Unable to configure OpenFeature exposure delivery: %s',
        'invalid direct intake'
      )
      sinon.assert.notCalled(setAgentStrategyStub)
    })

    it('should handle multiple enable calls gracefully', () => {
      openfeatureModule.enable(config)
      openfeatureModule.enable(config)

      sinon.assert.calledOnce(ExposuresWriterStub)
    })

    it('should destroy writer when disabled', () => {
      openfeatureModule.enable(config)
      openfeatureModule.disable()

      sinon.assert.calledOnce(mockWriter.destroy)
    })
  })

  describe('exposure event handling', () => {
    beforeEach(() => {
      openfeatureModule.enable(config)
    })

    it('appends to the exposures writer', () => {
      const exposureSubmitCh = channel('ffe:exposure:submit')
      const exposureEvent = {
        timestamp: Date.now(),
        allocation: { key: 'test-allocation' },
        flag: { key: 'test-flag' },
        variant: { key: 'test-variant' },
        subject: {
          id: 'user-123',
          type: 'user',
          attributes: {},
        },
      }

      exposureSubmitCh.publish(exposureEvent)

      sinon.assert.calledWith(mockWriter.append, exposureEvent)
    })

    it('handles array of exposure events', () => {
      const exposureSubmitCh = channel('ffe:exposure:submit')
      const exposureEvents = [
        {
          timestamp: Date.now(),
          allocation: { key: 'test-allocation-1' },
          flag: { key: 'test-flag-1' },
          variant: { key: 'test-variant-1' },
          subject: { id: 'user-123', type: 'user', attributes: {} },
        },
        {
          timestamp: Date.now(),
          allocation: { key: 'test-allocation-2' },
          flag: { key: 'test-flag-2' },
          variant: { key: 'test-variant-2' },
          subject: { id: 'user-456', type: 'user', attributes: {} },
        },
      ]

      exposureSubmitCh.publish(exposureEvents)

      sinon.assert.calledOnceWithExactly(mockWriter.append, exposureEvents)
    })

    it('flushes the exposures writer', () => {
      const flushCh = channel('ffe:writers:flush')

      flushCh.publish()

      sinon.assert.calledOnce(mockWriter.flush)
    })

    it('removes all subscribers when disabling', () => {
      const exposureSubmitCh = channel('ffe:exposure:submit')
      const flushCh = channel('ffe:writers:flush')

      openfeatureModule.disable()

      assert.strictEqual(exposureSubmitCh.hasSubscribers, false)
      assert.strictEqual(flushCh.hasSubscribers, false)
    })
  })
})
