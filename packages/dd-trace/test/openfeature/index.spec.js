'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

const { channel } = require('dc-polyfill')

describe('OpenFeature Module', () => {
  let config
  let openfeatureModule
  let mockWriter
  let ExposuresWriterStub
  let setAgentStrategyStub

  beforeEach(() => {
    config = {
      ffeFlushInterval: 1000,
      ffeTimeout: 5000
    }

    mockWriter = {
      append: sinon.spy(),
      flush: sinon.spy(),
      destroy: sinon.spy(),
      setEnabled: sinon.spy()
    }

    ExposuresWriterStub = sinon.stub().returns(mockWriter)
    setAgentStrategyStub = sinon.stub()

    openfeatureModule = proxyquire('../../src/openfeature', {
      './writers/exposures': ExposuresWriterStub,
      './writers/util': { setAgentStrategy: setAgentStrategyStub }
    })
  })

  afterEach(() => {
    openfeatureModule.disable()
  })

  describe('enable/disable', () => {
    it('should export enable and disable functions', () => {
      expect(openfeatureModule.enable).to.be.a('function')
      expect(openfeatureModule.disable).to.be.a('function')
    })

    it('should setup writer when enabled', () => {
      openfeatureModule.enable(config)

      expect(ExposuresWriterStub).to.have.been.calledOnceWith(config)
      expect(setAgentStrategyStub).to.have.been.calledOnce
    })

    it('should handle multiple enable calls gracefully', () => {
      openfeatureModule.enable(config)
      openfeatureModule.enable(config)

      expect(ExposuresWriterStub).to.have.been.calledOnce
    })

    it('should destroy writer when disabled', () => {
      openfeatureModule.enable(config)
      openfeatureModule.disable()

      expect(mockWriter.destroy).to.have.been.calledOnce
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
          attributes: {}
        }
      }

      exposureSubmitCh.publish(exposureEvent)

      expect(mockWriter.append).to.have.been.calledWith(exposureEvent)
    })

    it('handles array of exposure events', () => {
      const exposureSubmitCh = channel('ffe:exposure:submit')
      const exposureEvents = [
        {
          timestamp: Date.now(),
          allocation: { key: 'test-allocation-1' },
          flag: { key: 'test-flag-1' },
          variant: { key: 'test-variant-1' },
          subject: { id: 'user-123', type: 'user', attributes: {} }
        },
        {
          timestamp: Date.now(),
          allocation: { key: 'test-allocation-2' },
          flag: { key: 'test-flag-2' },
          variant: { key: 'test-variant-2' },
          subject: { id: 'user-456', type: 'user', attributes: {} }
        }
      ]

      exposureSubmitCh.publish(exposureEvents)

      expect(mockWriter.append).to.have.been.calledTwice
      expect(mockWriter.append.firstCall).to.have.been.calledWith(exposureEvents[0])
      expect(mockWriter.append.secondCall).to.have.been.calledWith(exposureEvents[1])
    })

    it('flushes the exposures writer', () => {
      const flushCh = channel('ffe:writers:flush')

      flushCh.publish()

      expect(mockWriter.flush).to.have.been.calledOnce
    })

    it('removes all subscribers when disabling', () => {
      const exposureSubmitCh = channel('ffe:exposure:submit')
      const flushCh = channel('ffe:writers:flush')

      openfeatureModule.disable()

      expect(exposureSubmitCh.hasSubscribers).to.be.false
      expect(flushCh.hasSubscribers).to.be.false
    })
  })
})
