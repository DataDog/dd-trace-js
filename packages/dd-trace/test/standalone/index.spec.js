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
  APM_TRACING_ENABLED_KEY,
  SAMPLING_MECHANISM_APPSEC,
  DECISION_MAKER_KEY,
  TRACE_SOURCE_PROPAGATION_KEY,
} = require('../../src/constants')
const { USER_KEEP } = require('../../../../ext/priority')
const TextMapPropagator = require('../../src/opentracing/propagation/text_map')
const TraceState = require('../../src/opentracing/propagation/tracestate')
const TraceSourcePrioritySampler = require('../../src/standalone/tracesource_priority_sampler')

const startCh = channel('dd-trace:span:start')
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
    let startChSubscribe
    let startChUnsubscribe
    let extractChSubscribe
    let extractChUnsubscribe

    beforeEach(() => {
      startChSubscribe = sinon.stub(startCh, 'subscribe')
      startChUnsubscribe = sinon.stub(startCh, 'unsubscribe')
      extractChSubscribe = sinon.stub(extractCh, 'subscribe')
      extractChUnsubscribe = sinon.stub(extractCh, 'unsubscribe')
    })

    it('should subscribe to start span if apmTracing disabled', () => {
      standalone.configure(config)

      sinon.assert.calledOnce(startChSubscribe)
      sinon.assert.calledOnce(extractChSubscribe)
    })

    it('should not subscribe to start span if apmTracing enabled', () => {
      config.apmTracingEnabled = true

      standalone.configure(config)

      sinon.assert.notCalled(startChSubscribe)
      sinon.assert.notCalled(extractChSubscribe)
      sinon.assert.notCalled(startChUnsubscribe)
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

  describe('onStartSpan', () => {
    it('should not add _dd.apm.enabled tag when standalone is disabled', () => {
      config.apmTracingEnabled = true
      standalone.configure(config)

      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
      })

      assert.ok(!span.context().hasTag(APM_TRACING_ENABLED_KEY))
    })

    it('should add _dd.apm.enabled tag when standalone is enabled', () => {
      standalone.configure(config)

      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
      })

      assert.ok(
        span.context().hasTag(APM_TRACING_ENABLED_KEY),
        `Available keys: ${inspect(Object.keys(span.context().getTags()))}`
      )
    })

    it('should not add _dd.apm.enabled tag in child spans with local parent', () => {
      standalone.configure(config)

      const parent = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
      })

      assert.strictEqual(parent.context().getTag(APM_TRACING_ENABLED_KEY), 0)

      const child = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
        parent,
      })

      assert.ok(!child.context().hasTag(APM_TRACING_ENABLED_KEY))
    })

    it('should add _dd.apm.enabled tag in child spans with remote parent', () => {
      standalone.configure(config)

      const parent = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
      })

      parent._isRemote = true

      const child = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
        parent,
      })

      assert.strictEqual(child.context().getTag(APM_TRACING_ENABLED_KEY), 0)
    })
  })

  describe('onSpanExtract', () => {
    it('should reset priority if _dd.p.ts not present', () => {
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 2,
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      assert.strictEqual(spanContext._sampling.priority, undefined)
    })

    it('should not reset dm if _dd.p.ts not present', () => {
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 2,
        'x-datadog-tags': '_dd.p.dm=-4',
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      assert.strictEqual(spanContext._trace.tags[DECISION_MAKER_KEY], '-4')
    })

    it('should keep priority if _dd.p.ts is present', () => {
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 2,
        'x-datadog-tags': '_dd.p.ts=02,_dd.p.dm=-5',
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      assert.strictEqual(spanContext._sampling.priority, USER_KEEP)
      assert.strictEqual(spanContext._trace.tags[DECISION_MAKER_KEY], '-5')
    })

    it('should set USER_KEEP priority if _dd.p.ts=02 is present', () => {
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 1,
        'x-datadog-tags': '_dd.p.ts=02',
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      assert.strictEqual(spanContext._sampling.priority, USER_KEEP)
    })

    it('should keep priority if apm tracing is enabled', () => {
      config.apmTracingEnabled = true
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 2,
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
