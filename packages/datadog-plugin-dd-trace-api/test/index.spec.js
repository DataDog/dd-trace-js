'use strict'

const assert = require('node:assert')

const dc = require('dc-polyfill')
const { after, before, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const {
  supportedConfigurations,
} = require('../../dd-trace/src/config/supported-configurations.json')

const SELF = Symbol('self')
const supportedConfigurationsWithDdTraceApi = {
  ...supportedConfigurations,
  DD_TRACE_DD_TRACE_API_ENABLED: [
    {
      implementation: 'A',
      type: 'boolean',
      default: 'true',
    },
  ],
}

const configHelperPath = require.resolve('../../dd-trace/src/config/helper')
const reloadedConfigHelper = proxyquire.noPreserveCache()(configHelperPath, {
  './supported-configurations.json': {
    supportedConfigurations: supportedConfigurationsWithDdTraceApi,
  },
})
Object.assign(require(configHelperPath), reloadedConfigHelper)

const agent = require('../../dd-trace/test/plugins/agent')

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
        dogstatsd: {},
      }
      const payload = {
        proxy: () => dummyTracer,
        args: [],
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
          ret: dummyScope,
        })
      })

      describe('scope:active', () => {
        it('should call underlying api', () => {
          scope = tracer.scope()
          const internalScope = scope._scope || scope
          sinon.spy(internalScope, 'active')
          testChannel({
            name: 'scope:active',
            fn: internalScope.active,
            self: dummyScope,
            ret: null,
            thisValue: internalScope,
          })
          internalScope.active.restore()
        })
      })

      describe('scope:activate', () => {
        it('should call underlying api', () => {
          scope = tracer.scope()
          const internalScope = scope._scope || scope
          sinon.spy(internalScope, 'activate')
          testChannel({
            name: 'scope:activate',
            fn: internalScope.activate,
            self: dummyScope,
            args: [undefined, undefined],
            thisValue: internalScope,
          })
          internalScope.activate.restore()
        })
      })

      describe('scope:bind', () => {
        it('should call underlying api', () => {
          scope = tracer.scope()
          const internalScope = scope._scope || scope
          sinon.spy(internalScope, 'bind')
          testChannel({
            name: 'scope:bind',
            fn: internalScope.bind,
            self: dummyScope,
            args: [undefined, undefined],
            thisValue: internalScope,
          })
          internalScope.bind.restore()
        })
      })
    })

    describe('startSpan', () => {
      let dummySpan
      let dummySpanContext
      let span
      let spanContext
      let internalSpan
      let internalSpanContext

      it('should call underlying api', () => {
        dummySpan = {}
        testChannel({
          name: 'startSpan',
          fn: tracer.startSpan,
          ret: dummySpan,
        })
        span = tracer.startSpan.getCall(0).returnValue
        internalSpan = span._span || span
      })

      describe('span:context', () => {
        const traceId = '1234567890abcdef'
        const spanId = 'abcdef1234567890'
        const traceparent = `00-${traceId}-${spanId}-01`

        it('should call underlying api', () => {
          dummySpanContext = {}
          sinon.spy(internalSpan, 'context')
          testChannel({
            name: 'span:context',
            fn: internalSpan.context,
            self: dummySpan,
            ret: dummySpanContext,
            thisValue: internalSpan,
          })
          spanContext = internalSpan.context.getCall(0).returnValue
          internalSpanContext = spanContext._spanContext || spanContext
          sinon.stub(internalSpanContext, 'toTraceId').callsFake(() => traceId)
          sinon.stub(internalSpanContext, 'toSpanId').callsFake(() => spanId)
          sinon.stub(internalSpanContext, 'toTraceparent').callsFake(() => traceparent)
          internalSpan.context.restore()
        })

        describe('context:toTraceId', () => {
          it('should call underlying api', () => {
            testChannel({
              name: 'context:toTraceId',
              fn: internalSpanContext.toTraceId,
              self: dummySpanContext,
              ret: traceId,
              thisValue: internalSpanContext,
            })
          })
        })

        describe('context:toSpanId', () => {
          it('should call underlying api', () => {
            testChannel({
              name: 'context:toSpanId',
              fn: internalSpanContext.toSpanId,
              self: dummySpanContext,
              ret: spanId,
              thisValue: internalSpanContext,
            })
          })
        })

        describe('context:toTraceparent', () => {
          it('should call underlying api', () => {
            testChannel({
              name: 'context:toTraceparent',
              fn: internalSpanContext.toTraceparent,
              self: dummySpanContext,
              ret: traceparent,
              thisValue: internalSpanContext,
            })
          })
        })
      })

      describe('span:setTag', () => {
        it('should call underlying api', () => {
          sinon.spy(internalSpan, 'setTag')
          testChannel({
            name: 'span:setTag',
            fn: internalSpan.setTag,
            self: dummySpan,
            ret: dummySpan,
            args: ['test.tag', 'test.value'],
            thisValue: internalSpan,
          })
          internalSpan.setTag.restore()
        })
      })

      describe('span:addTags', () => {
        it('should call underlying api', () => {
          sinon.spy(internalSpan, 'addTags')
          testChannel({
            name: 'span:addTags',
            fn: internalSpan.addTags,
            self: dummySpan,
            ret: dummySpan,
            args: [{ 'test.tag': 'test.value' }],
            thisValue: internalSpan,
          })
          internalSpan.addTags.restore()
        })
      })

      describe('span:finish', () => {
        it('should call underlying api', () => {
          sinon.spy(internalSpan, 'finish')
          testChannel({
            name: 'span:finish',
            fn: internalSpan.finish,
            self: dummySpan,
            args: [undefined],
            thisValue: internalSpan,
          })
          internalSpan.finish.restore()
        })
      })

      describe('span:addLink', () => {
        it('should call underlying api', () => {
          sinon.spy(internalSpan, 'addLink')
          testChannel({
            name: 'span:addLink',
            fn: internalSpan.addLink,
            self: dummySpan,
            ret: dummySpan,
            args: [dummySpanContext],
            thisValue: internalSpan,
          })
          internalSpan.addLink.restore()
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
            self: tracer[name],
          }
          if (typeof ret !== 'undefined') {
            options.ret = ret
          }
          testChannel(options)
        })
      })
    }

    function testChannel ({ name, fn, self = dummyTracer, ret, args = [], proxy, thisValue }) {
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
      assert.strictEqual(payload.ret.value, ret)
      sinon.assert.calledOnce(fn)
      assert.deepStrictEqual(fn.args, [args])
      if (typeof thisValue !== 'undefined') {
        assert.strictEqual(fn.thisValues[0], thisValue)
      }
    }
  })
})
