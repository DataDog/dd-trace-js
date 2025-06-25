'use strict'

const { expect } = require('chai')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

const t = require('tap')
require('../setup/core')

t.test('crashtracking', t => {
  t.test('crashtracker', t => {
    let crashtracker
    let binding
    let config
    let libdatadog
    let log

    t.beforeEach(() => {
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

    t.afterEach(() => {
      binding.init.restore()
      binding.updateConfig.restore()
      binding.updateMetadata.restore()
    })

    t.test('start', t => {
      t.test('should initialize the binding', t => {
        crashtracker.start(config)

        expect(binding.init).to.have.been.called
        expect(log.error).to.not.have.been.called
        t.end()
      })

      t.test('should initialize the binding only once', t => {
        crashtracker.start(config)
        crashtracker.start(config)

        expect(binding.init).to.have.been.calledOnce
        t.end()
      })

      t.test('should reconfigure when started multiple times', t => {
        crashtracker.start(config)
        crashtracker.start(config)

        expect(binding.updateConfig).to.have.been.called
        expect(binding.updateMetadata).to.have.been.called
        t.end()
      })

      t.test('should handle errors', t => {
        crashtracker.start(null)

        expect(() => crashtracker.start(config)).to.not.throw()
        t.end()
      })

      t.test('should handle unix sockets', t => {
        config.url = new URL('unix:///var/datadog/apm/test.socket')

        crashtracker.start(config)

        expect(binding.init).to.have.been.called
        expect(log.error).to.not.have.been.called
        t.end()
      })
      t.end()
    })

    t.test('configure', t => {
      t.test('should reconfigure the binding when started', t => {
        crashtracker.start(config)
        crashtracker.configure(config)

        expect(binding.updateConfig).to.have.been.called
        expect(binding.updateMetadata).to.have.been.called
        t.end()
      })

      t.test('should reconfigure the binding only when started', t => {
        crashtracker.configure(config)

        expect(binding.updateConfig).to.not.have.been.called
        expect(binding.updateMetadata).to.not.have.been.called
        t.end()
      })

      t.test('should handle errors', t => {
        crashtracker.start(config)
        crashtracker.configure(null)

        expect(() => crashtracker.configure(config)).to.not.throw()
        t.end()
      })
      t.end()
    })
    t.end()
  })
  t.end()
})
