'use strict'

const { assert } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const { channel } = require('dc-polyfill')

require('../setup/core')

const standalone = require('../../src/standalone')
const DatadogSpan = require('../../src/opentracing/span')
const {
  APM_TRACING_ENABLED_KEY,
  SAMPLING_MECHANISM_APPSEC,
  DECISION_MAKER_KEY,
  TRACE_SOURCE_PROPAGATION_KEY
} = require('../../src/constants')
const { USER_KEEP } = require('../../../../ext/priority')
const TextMapPropagator = require('../../src/opentracing/propagation/text-map')
const TraceState = require('../../src/opentracing/propagation/tracestate')
const TraceSourcePrioritySampler = require('../../src/standalone/tracesource-priority-sampler')

const startCh = channel('dd-trace:span:start')
const injectCh = channel('dd-trace:span:inject')
const extractCh = channel('dd-trace:span:extract')

describe('Disabled APM Tracing or Standalone', () => {
  let config
  let tracer, processor, prioritySampler

  beforeEach(() => {
    config = {
      apmTracingEnabled: false,

      tracePropagationStyle: {
        inject: ['datadog', 'tracecontext', 'b3'],
        extract: ['datadog']
      }
    }

    tracer = {}
    processor = {}
    prioritySampler = {}
  })

  afterEach(() => { sinon.restore() })

  describe('configure', () => {
    let startChSubscribe
    let startChUnsubscribe
    let injectChSubscribe
    let injectChUnsubscribe
    let extractChSubscribe
    let extractChUnsubscribe

    beforeEach(() => {
      startChSubscribe = sinon.stub(startCh, 'subscribe')
      startChUnsubscribe = sinon.stub(startCh, 'unsubscribe')
      injectChSubscribe = sinon.stub(injectCh, 'subscribe')
      injectChUnsubscribe = sinon.stub(injectCh, 'unsubscribe')
      extractChSubscribe = sinon.stub(extractCh, 'subscribe')
      extractChUnsubscribe = sinon.stub(extractCh, 'unsubscribe')
    })

    it('should subscribe to start span if apmTracing disabled', () => {
      standalone.configure(config)

      sinon.assert.calledOnce(startChSubscribe)
      sinon.assert.calledOnce(injectChSubscribe)
      sinon.assert.calledOnce(extractChSubscribe)
    })

    it('should not subscribe to start span if apmTracing enabled', () => {
      config.apmTracingEnabled = true

      standalone.configure(config)

      sinon.assert.notCalled(startChSubscribe)
      sinon.assert.notCalled(injectChSubscribe)
      sinon.assert.notCalled(extractChSubscribe)
      sinon.assert.notCalled(startChUnsubscribe)
      sinon.assert.notCalled(injectChUnsubscribe)
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
              }
            }
            return channels[name]
          }
        }
      })

      standalone.configure(config)
      standalone.configure(config)
      standalone.configure(config)

      Object.values(channels).forEach(channel => {
        sinon.assert.calledThrice(channel.unsubscribe)
        sinon.assert.calledThrice(channel.subscribe)
      })
    })

    it('should not return a prioritySampler when standalone ASM is disabled', () => {
      const prioritySampler = standalone.configure({ apmTracingEnabled: true })

      assert.isUndefined(prioritySampler)
    })

    it('should return a TraceSourcePrioritySampler when standalone ASM is enabled', () => {
      const prioritySampler = standalone.configure(config)

      assert.instanceOf(prioritySampler, TraceSourcePrioritySampler)
    })
  })

  describe('onStartSpan', () => {
    it('should not add _dd.apm.enabled tag when standalone is disabled', () => {
      config.apmTracingEnabled = true
      standalone.configure(config)

      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation'
      })

      assert.notProperty(span.context()._tags, APM_TRACING_ENABLED_KEY)
    })

    it('should add _dd.apm.enabled tag when standalone is enabled', () => {
      standalone.configure(config)

      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation'
      })

      assert.property(span.context()._tags, APM_TRACING_ENABLED_KEY)
    })

    it('should not add _dd.apm.enabled tag in child spans with local parent', () => {
      standalone.configure(config)

      const parent = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation'
      })

      assert.propertyVal(parent.context()._tags, APM_TRACING_ENABLED_KEY, 0)

      const child = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
        parent
      })

      assert.notProperty(child.context()._tags, APM_TRACING_ENABLED_KEY)
    })

    it('should add _dd.apm.enabled tag in child spans with remote parent', () => {
      standalone.configure(config)

      const parent = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation'
      })

      parent._isRemote = true

      const child = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
        parent
      })

      assert.propertyVal(child.context()._tags, APM_TRACING_ENABLED_KEY, 0)
    })
  })

  describe('onSpanExtract', () => {
    it('should reset priority if _dd.p.ts not present', () => {
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 2
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      assert.isUndefined(spanContext._sampling.priority)
    })

    it('should not reset dm if _dd.p.ts not present', () => {
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 2,
        'x-datadog-tags': '_dd.p.dm=-4'
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      assert.propertyVal(spanContext._trace.tags, DECISION_MAKER_KEY, '-4')
    })

    it('should keep priority if _dd.p.ts is present', () => {
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 2,
        'x-datadog-tags': '_dd.p.ts=02,_dd.p.dm=-5'
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      assert.strictEqual(spanContext._sampling.priority, USER_KEEP)
      assert.propertyVal(spanContext._trace.tags, DECISION_MAKER_KEY, '-5')
    })

    it('should set USER_KEEP priority if _dd.p.ts=02 is present', () => {
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 1,
        'x-datadog-tags': '_dd.p.ts=02'
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
        'x-datadog-sampling-priority': 2
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      assert.strictEqual(spanContext._sampling.priority, USER_KEEP)
    })
  })

  describe('onSpanInject', () => {
    it('should reset priority if apm tracing is disabled and there is no appsec event', () => {
      standalone.configure(config)

      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation'
      })

      span._spanContext._sampling = {
        priority: USER_KEEP,
        mechanism: SAMPLING_MECHANISM_APPSEC
      }

      const carrier = {}
      const propagator = new TextMapPropagator(config)
      propagator.inject(span._spanContext, carrier)

      assert.notProperty(carrier, 'x-datadog-trace-id')
      assert.notProperty(carrier, 'x-datadog-parent-id')
      assert.notProperty(carrier, 'x-datadog-sampling-priority')

      assert.notProperty(carrier, 'x-b3-traceid')
      assert.notProperty(carrier, 'x-b3-spanid')
    })

    it('should keep priority if apm tracing is disabled and there is an appsec event', () => {
      standalone.configure(config)

      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation'
      })

      span._spanContext._sampling = {
        priority: USER_KEEP,
        mechanism: SAMPLING_MECHANISM_APPSEC
      }

      span._spanContext._trace.tags[TRACE_SOURCE_PROPAGATION_KEY] = '02'

      const carrier = {}
      const propagator = new TextMapPropagator(config)
      propagator.inject(span._spanContext, carrier)

      assert.property(carrier, 'x-datadog-trace-id')
      assert.property(carrier, 'x-datadog-parent-id')
      assert.property(carrier, 'x-datadog-sampling-priority')
      assert.propertyVal(carrier, 'x-datadog-tags', '_dd.p.ts=02')
    })

    it('should not reset priority if standalone disabled', () => {
      config.apmTracingEnabled = true
      standalone.configure(config)

      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation'
      })

      span._spanContext._sampling = {
        priority: USER_KEEP,
        mechanism: SAMPLING_MECHANISM_APPSEC
      }

      const carrier = {}
      const propagator = new TextMapPropagator(config)
      propagator.inject(span._spanContext, carrier)

      assert.property(carrier, 'x-datadog-trace-id')
      assert.property(carrier, 'x-datadog-parent-id')
      assert.property(carrier, 'x-datadog-sampling-priority')

      assert.property(carrier, 'x-b3-traceid')
      assert.property(carrier, 'x-b3-spanid')
    })

    it('should clear tracestate datadog info', () => {
      standalone.configure(config)

      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation'
      })

      span._spanContext._sampling = {
        priority: USER_KEEP,
        mechanism: SAMPLING_MECHANISM_APPSEC
      }

      const tracestate = new TraceState()
      tracestate.set('dd', 't.tid:666b118100000000;t.dm:-1;s:1;p:73a164d716fcddff')
      tracestate.set('other', 'id:0xC0FFEE')
      span._spanContext._tracestate = tracestate

      const carrier = {}
      const propagator = new TextMapPropagator(config)
      propagator.inject(span._spanContext, carrier)

      assert.propertyVal(carrier, 'tracestate', 'other=id:0xC0FFEE')
      assert.notProperty(carrier, 'traceparent')
    })
  })
})
