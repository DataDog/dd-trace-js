'use strict'

const { channel } = require('dc-polyfill')
const standalone = require('../../src/appsec/standalone')
const { assert } = require('chai')

const onTracerConfigure = channel('datadog:tracer:configure')

describe('Appsec standalone', () => {
  let tracer

  describe('configure', () => {
    describe('apmTracingEnabled: false', () => {
      beforeEach(() => {
        tracer = { _prioritySampler: { _limiter: undefined } }
        standalone.configure({ apmTracingEnabled: false })
      })

      afterEach(() => {
        standalone.disable(true)
      })

      it('should configure RateLimiter if apmTracing is disabled', () => {
        onTracerConfigure.publish({ tracer })

        assert.propertyVal(tracer._prioritySampler._limiter, '_rateLimit', 1)
      })

      it('should configure RateLimiter only once', () => {
        let number = 0
        const tracer = {
          _prioritySampler: {
            get _limiter () {
              return undefined
            },
            set _limiter (limiter) {
              number++
            }
          }
        }

        standalone.configure({ apmTracingEnabled: false })
        standalone.configure({ apmTracingEnabled: false })
        standalone.configure({ apmTracingEnabled: false })

        onTracerConfigure.publish({ tracer })

        assert.equal(number, 1)
      })

      it('should unsubscribe if apmTracing is enabled again', () => {
        standalone.configure({ apmTracingEnabled: true })

        onTracerConfigure.publish({ tracer })

        assert.propertyVal(tracer._prioritySampler, '_limiter', undefined)
      })

      it('should unsubscribe if apmTracing is enabled again even if disabled by multiple actors', () => {
        standalone.configure({ apmTracingEnabled: false })
        standalone.configure({ apmTracingEnabled: false })

        standalone.configure({ apmTracingEnabled: true })

        onTracerConfigure.publish({ tracer })

        assert.propertyVal(tracer._prioritySampler, '_limiter', undefined)
      })
    })
  })

  describe('disable', () => {
    beforeEach(() => {
      tracer = { _prioritySampler: { _limiter: undefined } }
      standalone.disable(true)
    })

    it('should take into account number of actors which enabled standalone', () => {
      standalone.configure({ apmTracingEnabled: false })
      standalone.configure({ apmTracingEnabled: false })

      standalone.disable()

      onTracerConfigure.publish({ tracer })

      assert.propertyVal(tracer._prioritySampler._limiter, '_rateLimit', 1)
    })

    it('should take into account number of actors which enabled standalone (2 disable calls)', () => {
      standalone.configure({ apmTracingEnabled: false })
      standalone.configure({ apmTracingEnabled: false })

      standalone.disable()
      standalone.disable()

      onTracerConfigure.publish({ tracer })

      assert.propertyVal(tracer._prioritySampler, '_limiter', undefined)
    })

    it('should force disable', () => {
      standalone.configure({ apmTracingEnabled: false })
      standalone.configure({ apmTracingEnabled: false })

      standalone.disable(true)

      onTracerConfigure.publish({ tracer })

      assert.propertyVal(tracer._prioritySampler, '_limiter', undefined)
    })
  })
})
