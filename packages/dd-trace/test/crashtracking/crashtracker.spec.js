'use strict'

const { expect } = require('chai')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

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

        expect(binding.init).to.have.been.called
        expect(log.error).to.not.have.been.called
      })

      it('should initialize the binding only once', () => {
        crashtracker.start(config)
        crashtracker.start(config)

        expect(binding.init).to.have.been.calledOnce
      })

      it('should reconfigure when started multiple times', () => {
        crashtracker.start(config)
        crashtracker.start(config)

        expect(binding.updateConfig).to.have.been.called
        expect(binding.updateMetadata).to.have.been.called
      })

      it('should handle errors', () => {
        crashtracker.start(null)

        expect(() => crashtracker.start(config)).to.not.throw()
      })

      it('should handle unix sockets', () => {
        config.url = new URL('unix:///var/datadog/apm/test.socket')

        crashtracker.start(config)

        expect(binding.init).to.have.been.called
        expect(log.error).to.not.have.been.called
      })
    })

    describe('configure', () => {
      it('should reconfigure the binding when started', () => {
        crashtracker.start(config)
        crashtracker.configure(config)

        expect(binding.updateConfig).to.have.been.called
        expect(binding.updateMetadata).to.have.been.called
      })

      it('should reconfigure the binding only when started', () => {
        crashtracker.configure(config)

        expect(binding.updateConfig).to.not.have.been.called
        expect(binding.updateMetadata).to.not.have.been.called
      })

      it('should handle errors', () => {
        crashtracker.start(config)
        crashtracker.configure(null)

        expect(() => crashtracker.configure(config)).to.not.throw()
      })
    })
  })
})
