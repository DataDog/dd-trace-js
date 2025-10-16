'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

describe('FlaggingProvider', () => {
  let FlaggingProvider
  let mockTracer
  let mockConfig
  let mockChannel
  let log
  let channelStub

  beforeEach(() => {
    mockTracer = {
      _config: { service: 'test-service' }
    }

    mockConfig = {
      service: 'test-service',
      version: '1.0.0',
      env: 'test'
    }

    mockChannel = {
      publish: sinon.spy()
    }

    channelStub = sinon.stub().returns(mockChannel)

    log = {
      debug: sinon.spy(),
      error: sinon.spy(),
      warn: sinon.spy()
    }

    FlaggingProvider = proxyquire('../../src/openfeature/flagging_provider', {
      'dc-polyfill': {
        channel: channelStub
      },
      '../log': log
    })
  })

  describe('constructor', () => {
    it('should initialize with tracer and config', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      expect(provider._tracer).to.equal(mockTracer)
      expect(provider._config).to.equal(mockConfig)
    })

    it('should create exposure channel', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      expect(provider).to.exist
      expect(channelStub).to.have.been.calledWith('ffe:exposure:submit')
    })

    it('should log debug message on creation', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      expect(provider).to.exist
      expect(log.debug).to.have.been.calledWith('[FlaggingProvider] Created')
    })
  })

  describe('_setConfiguration', () => {
    it('should call setConfiguration when method exists', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      const setConfigSpy = sinon.spy(provider, 'setConfiguration')
      const ufc = { flags: { 'test-flag': {} } }

      provider._setConfiguration(ufc)

      expect(setConfigSpy).to.have.been.calledOnceWith(ufc)
      expect(log.debug).to.have.been.calledWith('[FlaggingProvider] Provider configuration updated')
    })

    it('should handle null/undefined configuration gracefully', () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      expect(() => provider._setConfiguration(null)).to.not.throw()
      expect(() => provider._setConfiguration(undefined)).to.not.throw()
    })
  })

  describe('inheritance', () => {
    it('should extend DatadogNodeServerProvider', () => {
      const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      expect(provider).to.be.instanceOf(DatadogNodeServerProvider)
    })
  })
})
