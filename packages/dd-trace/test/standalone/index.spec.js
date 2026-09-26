'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const { channel } = require('dc-polyfill')

require('../setup/core')
const getConfig = require('../../src/config')
const standalone = require('../../src/standalone')
const DatadogSpan = require('../../src/opentracing/span')

const {
  SAMPLING_MECHANISM_APPSEC,
  DECISION_MAKER_KEY,
  TRACE_SOURCE_PROPAGATION_KEY,
} = require('../../src/constants')
const { USER_KEEP } = require('../../../../ext/priority')
const TextMapPropagator = require('../../src/opentracing/propagation/text_map')
const TraceState = require('../../src/opentracing/propagation/tracestate')
const TraceSourcePrioritySampler = require('../../src/standalone/tracesource_priority_sampler')

const extractCh = channel('dd-trace:span:extract')

describe('Disabled APM Tracing or Standalone', () => {
  let config
  let tracer, processor, prioritySampler

  beforeEach(() => {
    config = {
      apmTracingEnabled: false,

      tracePropagationStyle: {
        inject: ['datadog', 'tracecontext', 'b3multi'],
        extract: ['datadog'],
      },
    }

    tracer = { _config: getConfig() }
    processor = {}
    prioritySampler = {}
  })

  afterEach(() => { sinon.restore() })

  describe('configure', () => {
    let extractChSubscribe
    let extractChUnsubscribe

    beforeEach(() => {
      extractChSubscribe = sinon.stub(extractCh, 'subscribe')
      extractChUnsubscribe = sinon.stub(extractCh, 'unsubscribe')
    })

    it('should subscribe to extract if apmTracing disabled', () => {
      standalone.configure(config)

      sinon.assert.calledOnce(extractChSubscribe)
    })

    it('should not subscribe to extract if apmTracing enabled', () => {
      config.apmTracingEnabled = true

      standalone.configure(config)

      sinon.assert.notCalled(extractChSubscribe)
      sinon.assert.notCalled(extractChUnsubscribe)
    })

    it('should unsubscribe before subscribing', () => {
      const channels = {}
      const standalone = proxyquire('../../src/standalone', {
        'dc-polyfill': {
          channel: (name) => {
            channels[name] = {
              subscribe: sinon.stub(),
              unsubscribe: sinon.stub(),
              get hasSubscribers () {
                return true
              },
            }
            return channels[name]
          },
        },
      })

      standalone.configure(config)
      standalone.configure(config)
      standalone.configure(config)

      assert.strictEqual(channels['dd-trace:span:inject'], undefined)
      Object.values(channels).forEach(channel => {
        sinon.assert.calledThrice(channel.unsubscribe)
        sinon.assert.calledThrice(channel.subscribe)
      })
    })

    it('should not return a prioritySampler when standalone ASM is disabled', () => {
      const prioritySampler = standalone.configure({ apmTracingEnabled: true })

      assert.strictEqual(prioritySampler, undefined)
    })

    it('should return a TraceSourcePrioritySampler when standalone ASM is enabled', () => {
      const prioritySampler = standalone.configure(config)

      assert.ok(prioritySampler instanceof TraceSourcePrioritySampler)
    })
  })

  describe('onSpanExtract', () => {
    it('should reset priority if _dd.p.ts not present', () => {
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': '123123',
        'x-datadog-parent-id': '345345',
        'x-datadog-sampling-priority': '2',
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      assert.strictEqual(spanContext._sampling.priority, undefined)
    })

    it('should not reset dm if _dd.p.ts not present', () => {
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': '123123',
        'x-datadog-parent-id': '345345',
        'x-datadog-sampling-priority': '2',
        'x-datadog-tags': '_dd.p.dm=-4',
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      assert.strictEqual(spanContext._trace.tags[DECISION_MAKER_KEY], '-4')
    })

    it('should keep priority if _dd.p.ts is present', () => {
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': '123123',
        'x-datadog-parent-id': '345345',
        'x-datadog-sampling-priority': '2',
        'x-datadog-tags': '_dd.p.ts=02,_dd.p.dm=-5',
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      assert.strictEqual(spanContext._sampling.priority, USER_KEEP)
      assert.strictEqual(spanContext._trace.tags[DECISION_MAKER_KEY], '-5')
    })

    for (const style of ['datadog', 'tracecontext']) {
      for (const priority of [-1, 0, 1, USER_KEEP]) {
        it(`marks an inherited ${style} priority ${priority} with a trace source as non-probabilistic`, () => {
          config.tracePropagationStyle.extract = style === 'datadog' ? ['datadog', 'tracecontext'] : ['tracecontext']
          config.tracePropagationStyle.inject = ['tracecontext']
          standalone.configure(config)

          try {
            const carrier = {
              'x-datadog-trace-id': '123',
              'x-datadog-parent-id': '456',
              'x-datadog-sampling-priority': String(priority),
              'x-datadog-tags': '_dd.p.ts=02,_dd.p.dm=-5',
              traceparent: `00-0000000000000000000000000000007b-00000000000001c8-${priority > 0 ? '01' : '00'}`,
              tracestate: `dd=s:${priority};t.ts:02;t.dm:-5,ot=rv:123456789abcde;th:8;extra:value`,
            }
            const propagator = new TextMapPropagator(config)
            const spanContext = propagator.extract(carrier)

            assert.strictEqual(spanContext._sampling.priority, USER_KEEP)
            assert.strictEqual(spanContext._sampling.isProbabilityDecision, false)

            const injected = propagator.inject(spanContext, {})
            assert.match(injected.traceparent, /-01$/)
            assert.strictEqual(TraceState.fromString(injected.tracestate).get('ot'), 'rv:123456789abcde;extra:value')
          } finally {
            standalone.configure({ apmTracingEnabled: true })
          }
        })
      }
    }

    it('should keep priority if apm tracing is enabled', () => {
      config.apmTracingEnabled = true
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': '123123',
        'x-datadog-parent-id': '345345',
        'x-datadog-sampling-priority': '2',
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      assert.strictEqual(spanContext._sampling.priority, USER_KEEP)
    })
  })

  describe('inject', () => {
    it('should not create a carrier when apm tracing is disabled and there is no appsec event', () => {
      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
      })

      span._spanContext._sampling = {
        priority: USER_KEEP,
        mechanism: SAMPLING_MECHANISM_APPSEC,
      }

      const propagator = new TextMapPropagator(config)

      assert.strictEqual(propagator.inject(span._spanContext), undefined)
    })

    it('should inject trace context when apm tracing is disabled and there is an appsec event', () => {
      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
      })

      span._spanContext._sampling = {
        priority: USER_KEEP,
        mechanism: SAMPLING_MECHANISM_APPSEC,
      }

      span._spanContext._trace.tags[TRACE_SOURCE_PROPAGATION_KEY] = '02'

      const propagator = new TextMapPropagator(config)
      const carrier = propagator.inject(span._spanContext)

      assert.ok(carrier)
      assert.ok(Object.hasOwn(carrier, 'x-datadog-trace-id'), `Available keys: ${inspect(Object.keys(carrier))}`)
      assert.ok(Object.hasOwn(carrier, 'x-datadog-parent-id'), `Available keys: ${inspect(Object.keys(carrier))}`)
      assert.ok(
        Object.hasOwn(carrier, 'x-datadog-sampling-priority'),
        `Available keys: ${inspect(Object.keys(carrier))}`
      )
      assert.strictEqual(carrier['x-datadog-tags'], '_dd.p.ts=02')
    })

    it('should keep the standalone trace source when other trace tags exceed the tracestate budget', () => {
      config.tracePropagationStyle.inject = ['tracecontext']
      config.tracePropagationStyle.extract = ['tracecontext']

      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
      })
      span._spanContext._sampling = {
        priority: USER_KEEP,
        mechanism: SAMPLING_MECHANISM_APPSEC,
      }
      span._spanContext._trace.tags['_dd.p.large'] = 'x'.repeat(230)
      span._spanContext._trace.tags[TRACE_SOURCE_PROPAGATION_KEY] = '02'

      const propagator = new TextMapPropagator(config)
      const carrier = propagator.inject(span._spanContext)
      assert.ok(carrier)
      assert.strictEqual(carrier['x-datadog-tags'], undefined)

      standalone.configure(config)
      try {
        const extracted = propagator.extract(carrier)
        assert.ok(extracted)
        assert.strictEqual(extracted._sampling.priority, USER_KEEP)
        assert.strictEqual(extracted._trace.tags[TRACE_SOURCE_PROPAGATION_KEY], '02')
      } finally {
        standalone.configure({ apmTracingEnabled: true })
      }
    })

    it('should inject trace context when standalone is disabled', () => {
      config.apmTracingEnabled = true

      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
      })

      span._spanContext._sampling = {
        priority: USER_KEEP,
        mechanism: SAMPLING_MECHANISM_APPSEC,
      }

      const propagator = new TextMapPropagator(config)
      const carrier = propagator.inject(span._spanContext)

      assert.ok(carrier)
      assert.ok(Object.hasOwn(carrier, 'x-datadog-trace-id'), `Available keys: ${inspect(Object.keys(carrier))}`)
      assert.ok(Object.hasOwn(carrier, 'x-datadog-parent-id'), `Available keys: ${inspect(Object.keys(carrier))}`)
      assert.ok(
        Object.hasOwn(carrier, 'x-datadog-sampling-priority'),
        `Available keys: ${inspect(Object.keys(carrier))}`
      )

      assert.ok(Object.hasOwn(carrier, 'x-b3-traceid'), `Available keys: ${inspect(Object.keys(carrier))}`)
      assert.ok(Object.hasOwn(carrier, 'x-b3-spanid'), `Available keys: ${inspect(Object.keys(carrier))}`)
    })

    it('should preserve non-Datadog tracestate without injecting traceparent', () => {
      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
      })

      span._spanContext._sampling = {
        priority: USER_KEEP,
        mechanism: SAMPLING_MECHANISM_APPSEC,
      }

      const tracestate = new TraceState()
      tracestate.set('dd', 't.tid:666b118100000000;t.dm:-1;s:1;p:73a164d716fcddff')
      tracestate.set('other', 'id:0xC0FFEE')
      span._spanContext._tracestate = tracestate

      const propagator = new TextMapPropagator(config)
      const carrier = propagator.inject(span._spanContext)

      assert.ok(carrier)
      assert.strictEqual(carrier.tracestate, 'other=id:0xC0FFEE')
      assert.ok(!('traceparent' in carrier))
    })

    it('should return a carrier when baggage remains after trace context is suppressed', () => {
      config.legacyBaggageEnabled = true
      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
      })
      span._spanContext._baggageItems.foo = 'bar'

      const carrier = new TextMapPropagator(config).inject(span._spanContext)

      assert.deepStrictEqual(carrier, { 'ot-baggage-foo': 'bar' })
    })
  })
})
