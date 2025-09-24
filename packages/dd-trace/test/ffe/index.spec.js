'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

const { channel } = require('dc-polyfill')

describe('FFE', () => {
  let ffe
  let config
  let ffeModule
  let mockWriter
  let ExposuresWriterStub

  beforeEach(() => {
    config = {
      ffeFlushInterval: 1000,
      ffeTimeout: 5000
    }

    // Mock the ExposuresWriter
    mockWriter = {
      append: sinon.spy(),
      flush: sinon.spy(),
      destroy: sinon.spy(),
      setEnabled: sinon.spy()
    }

    ExposuresWriterStub = sinon.stub().returns(mockWriter)

    // Use proxyquire to inject mocked dependencies
    ffeModule = proxyquire('../../src/ffe', {
      './writers/exposures': ExposuresWriterStub
    })

    ffe = ffeModule.enable(config)
  })

  afterEach(() => {
    ffeModule.disable()
  })

  describe('constructor', () => {
    it('should initialize with empty ufc store', () => {
      expect(ffe.ufc).to.be.an('object')
      expect(Object.keys(ffe.ufc)).to.have.length(0)
    })
  })

  describe('setConfig', () => {
    it('should store UFC configuration by configId', () => {
      const configId = 'org-42-env-prod'
      const ufcData = {
        flags: {
          'example-flag': {
            key: 'example-flag',
            enabled: true,
            variationType: 'BOOLEAN',
            variations: {
              true: { key: 'true', value: true },
              false: { key: 'false', value: false }
            },
            allocations: []
          }
        }
      }

      ffe.setConfig(configId, ufcData)

      expect(ffe.ufc[configId]).to.deep.equal(ufcData)
    })

    it('should overwrite existing config for same configId', () => {
      const configId = 'org-42-env-prod'
      const initialUfc = { flags: { flag1: { enabled: false } } }
      const updatedUfc = { flags: { flag1: { enabled: true } } }

      ffe.setConfig(configId, initialUfc)
      ffe.setConfig(configId, updatedUfc)

      expect(ffe.ufc[configId]).to.deep.equal(updatedUfc)
    })

    it('should store multiple configs with different configIds', () => {
      const prodConfig = { flags: { 'prod-flag': { enabled: true } } }
      const stagingConfig = { flags: { 'staging-flag': { enabled: false } } }

      ffe.setConfig('org-42-env-prod', prodConfig)
      ffe.setConfig('org-42-env-staging', stagingConfig)

      expect(ffe.ufc['org-42-env-prod']).to.deep.equal(prodConfig)
      expect(ffe.ufc['org-42-env-staging']).to.deep.equal(stagingConfig)
    })
  })

  describe('getConfig', () => {
    it('should return stored UFC configuration', () => {
      const configId = 'org-42-env-prod'
      const ufcData = { flags: { 'test-flag': { enabled: true } } }

      ffe.setConfig(configId, ufcData)
      const retrieved = ffe.getConfig(configId)

      expect(retrieved).to.deep.equal(ufcData)
    })

    it('should return undefined for non-existent configId', () => {
      const retrieved = ffe.getConfig('non-existent-config')
      expect(retrieved).to.be.undefined
    })
  })

  describe('removeConfig', () => {
    it('should remove UFC configuration by configId', () => {
      const configId = 'org-42-env-prod'
      const ufcData = { flags: { 'test-flag': { enabled: true } } }

      ffe.setConfig(configId, ufcData)
      expect(ffe.ufc[configId]).to.exist

      ffe.removeConfig(configId)
      expect(ffe.ufc[configId]).to.be.undefined
    })

    it('should not affect other configs when removing one', () => {
      const prodConfig = { flags: { 'prod-flag': { enabled: true } } }
      const stagingConfig = { flags: { 'staging-flag': { enabled: false } } }

      ffe.setConfig('org-42-env-prod', prodConfig)
      ffe.setConfig('org-42-env-staging', stagingConfig)

      ffe.removeConfig('org-42-env-prod')

      expect(ffe.ufc['org-42-env-prod']).to.be.undefined
      expect(ffe.ufc['org-42-env-staging']).to.deep.equal(stagingConfig)
    })

    it('should handle removing non-existent configId gracefully', () => {
      expect(() => ffe.removeConfig('non-existent')).to.not.throw()
    })
  })

  describe('modifyConfig', () => {
    it('should modify existing UFC configuration', () => {
      const configId = 'org-42-env-prod'
      const initialUfc = { flags: { flag1: { enabled: false } } }
      const modifications = { flags: { flag1: { enabled: true } } }

      ffe.setConfig(configId, initialUfc)
      ffe.modifyConfig(configId, modifications)

      expect(ffe.ufc[configId]).to.deep.equal(modifications)
    })

    it('should handle modifying non-existent config', () => {
      const result = ffe.modifyConfig('non-existent', { flags: {} })
      expect(result).to.be.undefined
    })
  })

  describe('module level functions', () => {
    it('should export enable and disable functions', () => {
      expect(ffeModule.enable).to.be.a('function')
      expect(ffeModule.disable).to.be.a('function')
    })

    it('should return FFE instance from enable', () => {
      const instance = ffeModule.enable(config)
      expect(instance).to.equal(ffe)
      expect(instance.constructor.name).to.equal('FFE')
    })

    it('should handle multiple enable calls gracefully', () => {
      const instance1 = ffeModule.enable(config)
      const instance2 = ffeModule.enable(config)
      expect(instance1).to.equal(instance2)
    })

    it('should expose config management functions', () => {
      expect(ffeModule.getConfig).to.be.a('function')
      expect(ffeModule.setConfig).to.be.a('function')
      expect(ffeModule.modifyConfig).to.be.a('function')
    })
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

    ffeModule.disable()

    expect(exposureSubmitCh.hasSubscribers).to.be.false
    expect(flushCh.hasSubscribers).to.be.false
  })
})
