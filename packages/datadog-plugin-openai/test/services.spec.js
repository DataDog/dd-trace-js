'use strict'

const sinon = require('sinon')
const proxyquire = require('proxyquire')

const services = require('../src/services')
const { getConfigFresh } = require('../../dd-trace/test/helpers/config')

describe('Plugin', () => {
  describe('openai services', () => {
    afterEach(() => {
      services.shutdown()
    })

    it('should initialize DogStatsDClient with explicit config values', () => {
      const flush = sinon.stub()
      const DogStatsDClient = sinon.stub().returns({
        flush,
      })
      const ExternalLogger = sinon.stub().returns({
        log: sinon.stub(),
      })
      const NoopDogStatsDClient = sinon.stub()
      const NoopExternalLogger = sinon.stub()
      const proxiedServices = proxyquire('../src/services', {
        '../../dd-trace/src/dogstatsd': { DogStatsDClient },
        '../../dd-trace/src/noop/dogstatsd': NoopDogStatsDClient,
        '../../dd-trace/src/external-logger/src': {
          ExternalLogger,
          NoopExternalLogger,
        },
      })
      const config = getConfigFresh({
        env: 'prod',
        hostname: 'foo',
        service: 'bar',
        version: '1.2.3',
      })

      proxiedServices.init(config)

      sinon.assert.calledOnceWithExactly(DogStatsDClient, {
        host: config.dogstatsd.hostname,
        lookup: config.lookup,
        port: config.dogstatsd.port,
        tags: [
          'service:bar',
          'env:prod',
          'version:1.2.3',
        ],
      })
      sinon.assert.notCalled(NoopDogStatsDClient)

      proxiedServices.shutdown()
    })

    describe('when unconfigured', () => {
      it('dogstatsd does not throw when missing .dogstatsd', () => {
        const service = services.init(getConfigFresh({
          hostname: 'foo',
          service: 'bar',
          apiKey: 'my api key',
          interval: 1000,
        }))

        service.metrics.increment('mykey')
        service.logger.log('hello')
      })

      it('logger does not throw', () => {
        const service = services.init(getConfigFresh({
          hostname: 'foo',
          service: 'bar',
          interval: 1000,
        }))

        service.logger.log('hello')
      })

      it('logger does not throw when passing in null', () => {
        const service = services.init(null)

        service.metrics.increment('mykey')
        service.logger.log('hello')
      })
    })
  })
})
