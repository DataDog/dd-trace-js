'use strict'

const { expect } = require('chai')
const dc = require('dc-polyfill')
const { describe, it, before, after } = require('mocha')
const sinon = require('sinon')

const assert = require('node:assert')

const agent = require('../../dd-trace/test/plugins/agent')

const SELF = Symbol('self')

describe('Plugin', () => {
  describe('dd-trace-api', () => {
    let dummyTracer
    let tracer

    const allChannels = new Set()
    const testedChannels = new Set()

    before(async () => {
      sinon.spy(dc, 'channel')

      await agent.load('dd-trace-api')

      tracer = require('../../dd-trace')

      // TODO: Use the real module when it's released.
      dc.channel('dd-trace:instrumentation:load').publish({ name: 'dd-trace-api' })

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
        testChannel({
          name: 'scope',
          fn: tracer.scope,
          ret: dummyScope
        })
      })

      describe('scope:active', () => {
        it('should call underlying api', () => {
          scope = tracer.scope()
          sinon.spy(scope, 'active')
          testChannel({
            name: 'scope:active',
            fn: scope.active,
            self: dummyScope,
            ret: null
          })
          scope.active.restore()
        })
      })

      describe('scope:activate', () => {
        it('should call underlying api', () => {
          scope = tracer.scope()
          sinon.spy(scope, 'activate')
          testChannel({
            name: 'scope:activate',
            fn: scope.activate,
            self: dummyScope
          })
          scope.activate.restore()
        })
      })

      describe('scope:bind', () => {
        it('should call underlying api', () => {
          scope = tracer.scope()
          sinon.spy(scope, 'bind')
          testChannel({
            name: 'scope:bind',
            fn: scope.bind,
            self: dummyScope
          })
          scope.bind.restore()
        })
      })
    })

    describe('startSpan', () => {
      let dummySpan
      let dummySpanContext
      let span
      let spanContext

      it('should call underlying api', () => {
        dummySpan = {}
        testChannel({
          name: 'startSpan',
          fn: tracer.startSpan,
          ret: dummySpan
        })
        span = tracer.startSpan.getCall(0).returnValue
        sinon.spy(span)
      })

      describe('span:context', () => {
        const traceId = '1234567890abcdef'
        const spanId = 'abcdef1234567890'
        const traceparent = `00-${traceId}-${spanId}-01`

        it('should call underlying api', () => {
          dummySpanContext = {}
          testChannel({
            name: 'span:context',
            fn: span.context,
            self: dummySpan,
            ret: dummySpanContext
          })
          spanContext = span.context.getCall(0).returnValue
          sinon.stub(spanContext, 'toTraceId').callsFake(() => traceId)
          sinon.stub(spanContext, 'toSpanId').callsFake(() => spanId)
          sinon.stub(spanContext, 'toTraceparent').callsFake(() => traceparent)
        })

        describe('context:toTraceId', () => {
          it('should call underlying api', () => {
            testChannel({
              name: 'context:toTraceId',
              fn: spanContext.toTraceId,
              self: dummySpanContext,
              ret: traceId
            })
          })
        })

        describe('context:toSpanId', () => {
          it('should call underlying api', () => {
            testChannel({
              name: 'context:toSpanId',
              fn: spanContext.toSpanId,
              self: dummySpanContext,
              ret: spanId
            })
          })
        })

        describe('context:toTraceparent', () => {
          it('should call underlying api', () => {
            testChannel({
              name: 'context:toTraceparent',
              fn: spanContext.toTraceparent,
              self: dummySpanContext,
              ret: traceparent
            })
          })
        })
      })

      describe('span:setTag', () => {
        it('should call underlying api', () => {
          testChannel({
            name: 'span:setTag',
            fn: span.setTag,
            self: dummySpan,
            ret: dummySpan
          })
        })
      })

      describe('span:addTags', () => {
        it('should call underlying api', () => {
          testChannel({
            name: 'span:addTags',
            fn: span.addTags,
            self: dummySpan,
            ret: dummySpan
          })
        })
      })

      describe('span:finish', () => {
        it('should call underlying api', () => {
          testChannel({
            name: 'span:finish',
            fn: span.finish,
            self: dummySpan
          })
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

    describeMethod('inject')
    describeMethod('extract', null)
    describeMethod('getRumData', '')
    describeMethod('trace')
    describeMethod('wrap')
    describeMethod('use', SELF)
    describeMethod('profilerStarted', Promise.resolve(false))

    describeSubsystem('appsec', 'blockRequest', false)
    describeSubsystem('appsec', 'isUserBlocked', false)
    describeSubsystem('appsec', 'setUser')
    describeSubsystem('appsec', 'trackCustomEvent')
    describeSubsystem('appsec', 'trackUserLoginFailureEvent')
    describeSubsystem('appsec', 'trackUserLoginSuccessEvent')
    describeSubsystem('dogstatsd', 'decrement')
    describeSubsystem('dogstatsd', 'distribution')
    describeSubsystem('dogstatsd', 'flush')
    describeSubsystem('dogstatsd', 'gauge')
    describeSubsystem('dogstatsd', 'histogram')
    describeSubsystem('dogstatsd', 'increment')

    after('dd-trace-api all events tested', () => {
      assert.deepStrictEqual([...allChannels].sort(), [...testedChannels].sort())
    })

    function describeMethod (name, ret) {
      describe(name, () => {
        it('should call underlying api', () => {
          if (ret === SELF) {
            ret = dummyTracer
          }
          testChannel({ name, fn: tracer[name], ret })
        })
      })
    }

    function describeSubsystem (name, command, ret) {
      describe(`${name}:${command}`, () => {
        it('should call underlying api', () => {
          const options = {
            name: `${name}:${command}`,
            fn: tracer[name][command],
            self: tracer[name]
          }
          if (typeof ret !== 'undefined') {
            options.ret = ret
          }
          testChannel(options)
        })
      })
    }

    function testChannel ({ name, fn, self = dummyTracer, ret, args = [], proxy }) {
      testedChannels.add('datadog-api:v1:' + name)
      const ch = dc.channel('datadog-api:v1:' + name)
      if (proxy === undefined) {
        proxy = ret && typeof ret === 'object' ? () => ret : undefined
      }
      const payload = { self, args, ret: {}, proxy, revProxy: [] }
      ch.publish(payload)
      if (payload.ret.error) {
        throw payload.ret.error
      }
      expect(payload.ret.value).to.equal(ret)
      expect(fn).to.have.been.calledOnceWithExactly(...args)
    }
  })
})
