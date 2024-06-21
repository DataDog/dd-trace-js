'use strict'

const { channel } = require('dc-polyfill')
const { assert } = require('chai')
const standalone = require('../../src/appsec/standalone')
const DatadogSpan = require('../../src/opentracing/span')
const {
  APM_TRACING_ENABLED_KEY,
  APPSEC_PROPAGATION_KEY,
  SAMPLING_MECHANISM_APPSEC,
  DECISION_MAKER_KEY
} = require('../../src/constants')
const { USER_KEEP, AUTO_KEEP, AUTO_REJECT } = require('../../../../ext/priority')
const TextMapPropagator = require('../../src/opentracing/propagation/text_map')
const TraceState = require('../../src/opentracing/propagation/tracestate')

const startCh = channel('dd-trace:span:start')
const injectCh = channel('dd-trace:span:inject')
const extractCh = channel('dd-trace:span:extract')

describe('Appsec Standalone', () => {
  let config
  let tracer, processor, prioritySampler

  beforeEach(() => {
    config = {
      appsec: { standalone: { enabled: true } },

      tracePropagationStyle: {
        inject: ['datadog', 'tracecontext'],
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

    it('should subscribe to start span if standalone enabled', () => {
      standalone.configure(config)

      sinon.assert.calledOnce(startChSubscribe)
      sinon.assert.calledOnce(injectChSubscribe)
      sinon.assert.calledOnce(extractChSubscribe)
    })

    it('should not subscribe to start span if standalone disabled', () => {
      delete config.appsec.standalone

      standalone.configure(config)

      sinon.assert.notCalled(startChSubscribe)
      sinon.assert.notCalled(injectChSubscribe)
      sinon.assert.notCalled(extractChSubscribe)
      sinon.assert.notCalled(startChUnsubscribe)
      sinon.assert.notCalled(injectChUnsubscribe)
      sinon.assert.notCalled(extractChUnsubscribe)
    })

    it('should subscribe only once', () => {
      standalone.configure(config)
      standalone.configure(config)
      standalone.configure(config)

      sinon.assert.calledOnce(startChSubscribe)
    })

    it('should not return a prioritySampler when standalone ASM is disabled', () => {
      const prioritySampler = standalone.configure({ appsec: { standalone: { enabled: false } } })

      assert.isUndefined(prioritySampler)
    })

    it('should return a StandAloneAsmPrioritySampler when standalone ASM is enabled', () => {
      const prioritySampler = standalone.configure(config)

      assert.instanceOf(prioritySampler, standalone.StandAloneAsmPrioritySampler)
    })
  })

  describe('onStartSpan', () => {
    it('should not add _dd.apm.enabled tag when standalone is disabled', () => {
      delete config.appsec.standalone
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
    it('should reset priority if _dd.p.appsec not present', () => {
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

    it('should reset dm if _dd.p.appsec not present', () => {
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 2,
        'x-datadog-tags': '_dd.p.dm=-4'
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      assert.notProperty(spanContext._trace.tags, DECISION_MAKER_KEY)
    })

    it('should keep priority if _dd.p.appsec is present', () => {
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 2,
        'x-datadog-tags': '_dd.p.appsec=1,_dd.p.dm=-5'
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      assert.strictEqual(spanContext._sampling.priority, USER_KEEP)
      assert.propertyVal(spanContext._trace.tags, DECISION_MAKER_KEY, '-5')
    })

    it('should set USER_KEEP priority if _dd.p.appsec=1 is present', () => {
      standalone.configure(config)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 1,
        'x-datadog-tags': '_dd.p.appsec=1'
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      assert.strictEqual(spanContext._sampling.priority, USER_KEEP)
    })

    it('should keep priority if standalone is disabled', () => {
      delete config.appsec.standalone
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
    it('should reset priority if standalone enabled and there is no appsec event', () => {
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
    })

    it('should keep priority if standalone enabled and there is an appsec event', () => {
      standalone.configure(config)

      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation'
      })

      span._spanContext._sampling = {
        priority: USER_KEEP,
        mechanism: SAMPLING_MECHANISM_APPSEC
      }

      span._spanContext._trace.tags[APPSEC_PROPAGATION_KEY] = '1'

      const carrier = {}
      const propagator = new TextMapPropagator(config)
      propagator.inject(span._spanContext, carrier)

      assert.property(carrier, 'x-datadog-trace-id')
      assert.property(carrier, 'x-datadog-parent-id')
      assert.property(carrier, 'x-datadog-sampling-priority')
      assert.propertyVal(carrier, 'x-datadog-tags', '_dd.p.appsec=1')
    })

    it('should not reset priority if standalone disabled', () => {
      delete config.appsec.standalone
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
    })
  })

  describe('StandaloneASMPriorityManager', () => {
    let prioritySampler
    let tags
    let context

    beforeEach(() => {
      tags = { 'manual.keep': 'true' }
      prioritySampler = new standalone.StandAloneAsmPrioritySampler('test')

      context = {
        _sampling: {},
        _trace: {
          tags: {}
        }
      }
      sinon.stub(prioritySampler, '_getContext').returns(context)
    })

    describe('_getPriorityFromTags', () => {
      it('should keep the trace if manual.keep and _dd.p.appsec are present', () => {
        context._trace.tags[APPSEC_PROPAGATION_KEY] = 1
        assert.strictEqual(prioritySampler._getPriorityFromTags(tags, context), USER_KEEP)
        assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_APPSEC)
      })

      it('should return undefined if manual.keep or _dd.p.appsec are not present', () => {
        assert.isUndefined(prioritySampler._getPriorityFromTags(tags, context))
      })
    })

    describe('_getPriorityFromAuto', () => {
      it('should keep one trace per 1 min', () => {
        const span = {
          _trace: {}
        }

        const clock = sinon.useFakeTimers(new Date())

        assert.strictEqual(prioritySampler._getPriorityFromAuto(span), AUTO_KEEP)
        assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_APPSEC)

        assert.strictEqual(prioritySampler._getPriorityFromAuto(span), AUTO_REJECT)

        clock.tick(30000)

        assert.strictEqual(prioritySampler._getPriorityFromAuto(span), AUTO_REJECT)

        clock.tick(60000)

        assert.strictEqual(prioritySampler._getPriorityFromAuto(span), AUTO_KEEP)

        clock.restore()
      })

      it('should keep trace if it contains _dd.p.appsec tag', () => {
        const span = {
          _trace: {}
        }

        context._trace.tags[APPSEC_PROPAGATION_KEY] = 1

        assert.strictEqual(prioritySampler._getPriorityFromAuto(span), USER_KEEP)
      })
    })
  })
})
