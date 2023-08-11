'use strict'

const services = require('../src/services')

describe('Plugin', () => {
  describe('openai services', () => {
    describe('when unconfigured', () => {
      afterEach(() => {
        services.shutdown()
      })

      it('dogstatsd does not throw when missing .dogstatsd', () => {
        const service = services.init({
          hostname: 'foo',
          service: 'bar',
          apiKey: 'my api key',
          interval: 1000
        })

        service.metrics.increment('mykey')
        service.logger.log('hello')
      })

      it('logger does not throw', () => {
        const service = services.init({
          hostname: 'foo',
          service: 'bar',
          interval: 1000
        })

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
