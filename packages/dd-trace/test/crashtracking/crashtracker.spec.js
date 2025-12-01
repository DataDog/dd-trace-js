'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')
require('../setup/core')

describe('crashtracking', () => {
  describe('crashtracker', () => {
    let crashtracker
    let binding
    let config
    let libdatadog
    let log

    beforeEach(() => {
      libdatadog = require('@datadog/libdatadog')

      binding = libdatadog.load('crashtracker')

      config = {
        port: 7357,
        tags: {
          foo: 'bar'
        }
      }

      log = {
        error: sinon.stub()
      }

      sinon.spy(binding, 'init')
      sinon.spy(binding, 'updateConfig')
      sinon.spy(binding, 'updateMetadata')

      crashtracker = proxyquire('../../src/crashtracking/crashtracker', {
        '../log': log
      })
    })

    afterEach(() => {
      binding.init.restore()
      binding.updateConfig.restore()
      binding.updateMetadata.restore()
    })

    describe('start', () => {
      it('should initialize the binding', () => {
        crashtracker.start(config)

        sinon.assert.called(binding.init)
        sinon.assert.notCalled(log.error)
      })

      it('should initialize the binding only once', () => {
        crashtracker.start(config)
        crashtracker.start(config)

        sinon.assert.calledOnce(binding.init)
      })

      it('should reconfigure when started multiple times', () => {
        crashtracker.start(config)
        crashtracker.start(config)

        sinon.assert.called(binding.updateConfig)
        sinon.assert.called(binding.updateMetadata)
      })

      it('should handle errors', () => {
        crashtracker.start(null)

        assert.doesNotThrow(() => crashtracker.start(config))
      })

      it('should handle unix sockets', () => {
        config.url = new URL('unix:///var/datadog/apm/test.socket')

        crashtracker.start(config)

        sinon.assert.called(binding.init)
        sinon.assert.notCalled(log.error)
      })
    })

    describe('configure', () => {
      it('should reconfigure the binding when started', () => {
        crashtracker.start(config)
        crashtracker.configure(config)

        sinon.assert.called(binding.updateConfig)
        sinon.assert.called(binding.updateMetadata)
      })

      it('should reconfigure the binding only when started', () => {
        crashtracker.configure(config)

        sinon.assert.notCalled(binding.updateConfig)
        sinon.assert.notCalled(binding.updateMetadata)
      })

      it('should handle errors', () => {
        crashtracker.start(config)
        crashtracker.configure(null)

        assert.doesNotThrow(() => crashtracker.configure(config))
      })
    })
  })
})
