'use strict'

const dc = require('dc-polyfill')

const agent = require('../../dd-trace/test/plugins/agent')
const assert = require('assert')

describe('Plugin', () => {
  describe('dd-trace-api', () => {
    let dummyTracer
    let tracer

    const allChannels = new Set()
    const testedChannels = new Set()

    function testChannel ({ name, fn, self = dummyTracer, ret = undefined, args = [] }) {
      testedChannels.add('datadog-api:v1:' + name)
      const ch = dc.channel('datadog-api:v1:' + name)
      const payload = {
        self,
        args,
        ret: {},
        proxy: ret && typeof ret === 'object' ? () => ret : undefined,
        revProxy: []
      }
      ch.publish(payload)
      if (payload.ret.error) {
        throw payload.ret.error
      }
      expect(payload.ret.value).to.equal(ret)
      expect(fn).to.have.been.calledOnceWithExactly(...args)
    }

    before(async () => {
      sinon.spy(dc, 'channel')

      await agent.load('dd-trace-api')

      tracer = require('../../dd-trace')

      sinon.spy(tracer)
      sinon.spy(tracer.appsec)
      sinon.spy(tracer.dogstatsd)

      for (let i = 0; i < dc.channel.callCount; i++) {
        const call = dc.channel.getCall(i)
        const channel = call.args[0]
        if (channel.startsWith('datadog-api:v1:') && !channel.endsWith('tracerinit')) {
          allChannels.add(channel)
        }
      }

      dummyTracer = {
        appsec: {},
        dogstatsd: {}
      }
      const payload = {
        proxy: () => dummyTracer,
        args: []
      }
      dc.channel('datadog-api:v1:tracerinit').publish(payload)
    })

    after(() => agent.close({ ritmReset: false }))

    describe('scope', () => {
      let dummyScope
      let scope

      it('should call underlying api', () => {
        dummyScope = {}
        testChannel({ name: 'scope', fn: tracer.scope, ret: dummyScope })
      })

      describe('scope:active', () => {
        it('should call underlying api', () => {
          scope = tracer.scope()
          sinon.spy(scope, 'active')
          testChannel({ name: 'scope:active', fn: scope.active, self: dummyScope, ret: null })
          scope.active.restore()
        })
      })

      describe('scope:activate', () => {
        it('should call underlying api', () => {
          scope = tracer.scope()
          sinon.spy(scope, 'activate')
          testChannel({ name: 'scope:activate', fn: scope.activate, self: dummyScope })
          scope.activate.restore()
        })
      })

      describe('scope:bind', () => {
        it('should call underlying api', () => {
          scope = tracer.scope()
          sinon.spy(scope, 'bind')
          testChannel({ name: 'scope:bind', fn: scope.bind, self: dummyScope })
          scope.bind.restore()
        })
      })
    })

    describe('inject', () => {
      it('should call underlying api', () => {
        testChannel({ name: 'inject', fn: tracer.inject })
      })
    })

    describe('extract', () => {
      it('should call underlying api', () => {
        testChannel({ name: 'extract', fn: tracer.extract, ret: null })
      })
    })

    describe('getRumData', () => {
      it('should call underlying api', () => {
        testChannel({ name: 'getRumData', fn: tracer.getRumData, ret: '' })
      })
    })

    describe('trace', () => {
      it('should call underlying api', () => {
        testChannel({ name: 'trace', fn: tracer.trace })
      })
    })

    describe('wrap', () => {
      it('should call underlying api', () => {
        testChannel({ name: 'wrap', fn: tracer.wrap })
      })
    })

    describe('use', () => {
      it('should call underlying api', () => {
        testChannel({ name: 'use', fn: tracer.use, ret: dummyTracer })
      })
    })

    describe('profilerStarted', () => {
      it('should call underlying api', () => {
        testChannel({ name: 'profilerStarted', fn: tracer.profilerStarted, ret: Promise.resolve(false) })
      })
    })

    describe('startSpan', () => {
      let dummySpan
      let dummySpanContext
      let span
      let spanContext

      it('should call underlying api', () => {
        dummySpan = {}
        testChannel({ name: 'startSpan', fn: tracer.startSpan, ret: dummySpan })
        span = tracer.startSpan.getCall(0).returnValue
        sinon.spy(span)
      })

      describe('span:context', () => {
        it('should call underlying api', () => {
          dummySpanContext = {}
          testChannel({ name: 'span:context', fn: span.context, self: dummySpan, ret: dummySpanContext })
          spanContext = span.context.getCall(0).returnValue
          sinon.spy(spanContext)
        })
      })

      describe('span:setTag', () => {
        it('should call underlying api', () => {
          testChannel({ name: 'span:setTag', fn: span.setTag, self: dummySpan, ret: dummySpan })
        })
      })

      describe('span:addTags', () => {
        it('should call underlying api', () => {
          testChannel({ name: 'span:addTags', fn: span.addTags, self: dummySpan, ret: dummySpan })
        })
      })

      describe('span:finish', () => {
        it('should call underlying api', () => {
          testChannel({ name: 'span:finish', fn: span.finish, self: dummySpan })
        })
      })

      describe('span:addLink', () => {
        it('should call underlying api', () => {
          testChannel({
            name: 'span:addLink',
            fn: span.addLink,
            self: dummySpan,
            ret: dummySpan,
            args: [dummySpanContext]
          })
        })
      })
    })

    describe('appsec:blockRequest', () => {
      it('should call underlying api', () => {
        testChannel({
          name: 'appsec:blockRequest',
          fn: tracer.appsec.blockRequest,
          self: tracer.appsec,
          ret: false
        })
      })
    })

    describe('appsec:isUserBlocked', () => {
      it('should call underlying api', () => {
        testChannel({
          name: 'appsec:isUserBlocked',
          fn: tracer.appsec.isUserBlocked,
          self: tracer.appsec,
          ret: false
        })
      })
    })

    describe('appsec:setUser', () => {
      it('should call underlying api', () => {
        testChannel({
          name: 'appsec:setUser',
          fn: tracer.appsec.setUser,
          self: tracer.appsec
        })
      })
    })

    describe('appsec:trackCustomEvent', () => {
      it('should call underlying api', () => {
        testChannel({
          name: 'appsec:trackCustomEvent',
          fn: tracer.appsec.trackCustomEvent,
          self: tracer.appsec
        })
      })
    })

    describe('appsec:trackUserLoginFailureEvent', () => {
      it('should call underlying api', () => {
        testChannel({
          name: 'appsec:trackUserLoginFailureEvent',
          fn: tracer.appsec.trackUserLoginFailureEvent,
          self: tracer.appsec
        })
      })
    })

    describe('appsec:trackUserLoginSuccessEvent', () => {
      it('should call underlying api', () => {
        testChannel({
          name: 'appsec:trackUserLoginSuccessEvent',
          fn: tracer.appsec.trackUserLoginSuccessEvent,
          self: tracer.appsec
        })
      })
    })

    describe('dogstatsd:decrement', () => {
      it('should call underlying api', () => {
        testChannel({
          name: 'dogstatsd:decrement',
          fn: tracer.dogstatsd.decrement,
          self: tracer.dogstatsd
        })
      })
    })

    describe('dogstatsd:distribution', () => {
      it('should call underlying api', () => {
        testChannel({
          name: 'dogstatsd:distribution',
          fn: tracer.dogstatsd.distribution,
          self: tracer.dogstatsd
        })
      })
    })

    describe('dogstatsd:flush', () => {
      it('should call underlying api', () => {
        testChannel({
          name: 'dogstatsd:flush',
          fn: tracer.dogstatsd.flush,
          self: tracer.dogstatsd
        })
      })
    })

    describe('dogstatsd:gauge', () => {
      it('should call underlying api', () => {
        testChannel({
          name: 'dogstatsd:gauge',
          fn: tracer.dogstatsd.gauge,
          self: tracer.dogstatsd
        })
      })
    })

    describe('dogstatsd:histogram', () => {
      it('should call underlying api', () => {
        testChannel({
          name: 'dogstatsd:histogram',
          fn: tracer.dogstatsd.histogram,
          self: tracer.dogstatsd
        })
      })
    })

    describe('dogstatsd:increment', () => {
      it('should call underlying api', () => {
        testChannel({
          name: 'dogstatsd:increment',
          fn: tracer.dogstatsd.increment,
          self: tracer.dogstatsd
        })
      })
    })

    after('dd-trace-api all events tested', () => {
      assert.deepStrictEqual([...allChannels].sort(), [...testedChannels].sort())
    })
  })
})
