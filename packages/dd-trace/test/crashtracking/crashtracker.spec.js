'use strict'

const { expect } = require('chai')
const sinon = require('sinon')
const pkg = require('../../../../package.json')
const proxyquire = require('proxyquire').noCallThru()

require('../setup/tap')

describe('crashtracking', () => {
  describe('crashtracker', () => {
    let crashtracker
    let binding
    let config
    let crashtrackerConfig
    let crashtrackerMetadata
    let crashtrackerReceiverConfig
    let libdatadog

    beforeEach(() => {
      config = {
        port: 7357,
        tags: {
          foo: 'bar'
        }
      }

      crashtrackerConfig = {
        endpoint: {
          url: {
            scheme: 'http',
            authority: '127.0.0.1:7357',
            path_and_query: ''
          }
        },
        resolve_frames: 'EnabledWithInprocessSymbols'
      }

      crashtrackerReceiverConfig = {
        path_to_receiver_binary: '/test/receiver'
      }

      crashtrackerMetadata = {
        tags: [
          'foo:bar',
          'is_crash:true',
          'language:javascript',
          `library_version:${pkg.version}`,
          'runtime:nodejs',
          'severity:crash'
        ]
      }

      binding = {
        initWithReceiver: sinon.stub(),
        updateConfig: sinon.stub(),
        updateMetadata: sinon.stub()
      }

      libdatadog = {
        find: sinon.stub(),
        load: sinon.stub()
      }
      libdatadog.find.withArgs('crashtracker-receiver', true).returns('/test/receiver')
      libdatadog.load.withArgs('crashtracker').returns(binding)

      crashtracker = proxyquire('../../src/crashtracking/crashtracker', {
        '@datadog/libdatadog': libdatadog
      })
    })

    describe('start', () => {
      it('should initialize the binding', () => {
        crashtracker.start(config)

        expect(binding.initWithReceiver).to.have.been.calledWithMatch(
          crashtrackerConfig,
          crashtrackerReceiverConfig,
          crashtrackerMetadata
        )
      })

      it('should initialize the binding only once', () => {
        crashtracker.start(config)
        crashtracker.start(config)

        expect(binding.initWithReceiver).to.have.been.calledOnce
      })

      it('should reconfigure when started multiple times', () => {
        crashtracker.start(config)
        crashtracker.start(config)

        expect(binding.updateConfig).to.have.been.calledWithMatch(crashtrackerConfig)
        expect(binding.updateMetadata).to.have.been.calledWithMatch(crashtrackerMetadata)
      })

      it('should handle errors', () => {
        binding.initWithReceiver.throws(new Error('boom'))

        crashtracker.start(config)

        expect(() => crashtracker.start(config)).to.not.throw()
      })
    })

    describe('configure', () => {
      it('should reconfigure the binding when started', () => {
        crashtracker.start(config)
        crashtracker.configure(config)

        expect(binding.updateConfig).to.have.been.calledWithMatch(crashtrackerConfig)
        expect(binding.updateMetadata).to.have.been.calledWithMatch(crashtrackerMetadata)
      })

      it('should reconfigure the binding only when started', () => {
        crashtracker.configure(config)

        expect(binding.updateConfig).to.not.have.been.called
        expect(binding.updateMetadata).to.not.have.been.called
      })

      it('should handle errors', () => {
        binding.updateConfig.throws(new Error('boom'))
        binding.updateMetadata.throws(new Error('boom'))

        crashtracker.start(config)
        crashtracker.configure(config)

        expect(() => crashtracker.configure(config)).to.not.throw()
      })
    })
  })
})
