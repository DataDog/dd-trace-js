'use strict'

const { channel } = require('dc-polyfill')
const startCh = channel('dd-trace:span:start')

const standalone = require('../../src/appsec/standalone')
const DatadogSpan = require('../../src/opentracing/span')
const { APM_TRACING_ENABLED_KEY, APPSEC_PROPAGATION_KEY, SAMPLING_MECHANISM_APPSEC } = require('../../src/constants')
const { USER_KEEP, AUTO_KEEP, AUTO_REJECT } = require('../../../../ext/priority')
const TextMapPropagator = require('../../src/opentracing/propagation/text_map')

describe('Appsec Standalone', () => {
  let config
  let tracer, processor, prioritySampler

  beforeEach(() => {
    config = {
      appsec: { standalone: { enabled: true } },

      tracePropagationStyle: {
        inject: ['datadog'],
        extract: ['datadog']
      }
    }

    tracer = {
      setPrioritySampler: sinon.stub()
    }
    processor = {}
    prioritySampler = {}
  })

  afterEach(sinon.restore)

  describe('configure', () => {
    let startChSubscribe
    let startChUnsubscribe

    beforeEach(() => {
      startChSubscribe = sinon.stub(startCh, 'subscribe')
      startChUnsubscribe = sinon.stub(startCh, 'unsubscribe')

      tracer = {
        setPrioritySampler: sinon.stub()
      }
    })

    it('should subscribe to start span if standalone enabled', () => {
      standalone.configure(config, tracer)

      expect(startChSubscribe).to.be.calledOnce
    })

    it('should not subscribe to start span if standalone disabled', () => {
      delete config.appsec.standalone

      standalone.configure(config, tracer)

      expect(startChUnsubscribe).to.be.calledOnce
    })

    it('should set prioritySampler only when config changes', () => {
      standalone.configure({}, tracer)
      standalone.configure({}, tracer)
      standalone.configure({}, tracer)

      expect(tracer.setPrioritySampler).to.not.have.been.calledOnce
    })

    it('should not return a prioritySampler when standalone ASM is disabled', () => {
      const prioritySampler = standalone.configure({ appsec: { standalone: { enabled: false } } }, tracer)

      expect(prioritySampler).to.undefined
    })

    it('should return a StandAloneAsmPrioritySampler when standalone ASM is enabled', () => {
      const prioritySampler = standalone.configure(config, tracer)

      expect(prioritySampler).to.not.undefined
      expect(prioritySampler instanceof standalone.StandAloneAsmPrioritySampler).to.be.true
    })
  })

  describe('onStartSpan', () => {
    it('should not add _dd.apm.enabled tag when standalone is disabled', () => {
      delete config.appsec.standalone
      standalone.configure(config, tracer)

      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation'
      })

      expect(span.context()._tags).to.not.have.property(APM_TRACING_ENABLED_KEY)
    })

    it('should add _dd.apm.enabled tag when standalone is enabled', () => {
      standalone.configure(config, tracer)

      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation'
      })

      expect(span.context()._tags).to.have.property(APM_TRACING_ENABLED_KEY)
    })

    it('should not add _dd.apm.enabled tag in child spans with local parent', () => {
      standalone.configure(config, tracer)

      const parent = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation'
      })

      expect(parent.context()._tags).to.have.property(APM_TRACING_ENABLED_KEY)
      expect(parent.context()._tags[APM_TRACING_ENABLED_KEY]).to.equal(0)

      const child = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
        parent
      })

      expect(child.context()._tags).to.not.have.property(APM_TRACING_ENABLED_KEY)
    })

    it('should add _dd.apm.enabled tag in child spans with remote parent', () => {
      standalone.configure(config, tracer)

      const parent = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation'
      })

      parent._isRemote = true

      const child = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation',
        parent
      })

      expect(child.context()._tags).to.have.property(APM_TRACING_ENABLED_KEY)
      expect(child.context()._tags[APM_TRACING_ENABLED_KEY]).to.equal(0)
    })
  })

  describe('onSpanExtract', () => {
    it('should reset priority if _dd.p.appsec not present', () => {
      standalone.configure(config, tracer)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 2
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      expect(spanContext._sampling.priority).to.undefined
    })

    it('should keep priority if _dd.p.appsec is present', () => {
      standalone.configure(config, tracer)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 2,
        'x-datadog-tags': '_dd.p.appsec=1'
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      expect(spanContext._sampling.priority).to.equal(USER_KEEP)
    })

    it('should set USER_KEEP priority if _dd.p.appsec=1 is present', () => {
      standalone.configure(config, tracer)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 1,
        'x-datadog-tags': '_dd.p.appsec=1'
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      expect(spanContext._sampling.priority).to.equal(USER_KEEP)
    })

    it('should keep priority if standalone is disabled', () => {
      delete config.appsec.standalone
      standalone.configure(config, tracer)

      const carrier = {
        'x-datadog-trace-id': 123123,
        'x-datadog-parent-id': 345345,
        'x-datadog-sampling-priority': 2
      }

      const propagator = new TextMapPropagator(config)
      const spanContext = propagator.extract(carrier)

      expect(spanContext._sampling.priority).to.equal(USER_KEEP)
    })
  })

  describe('onSpanInject', () => {
    it('should reset priority if standalone enabled and there is no appsec event', () => {
      standalone.configure(config, tracer)

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

      expect(carrier).to.not.have.property('x-datadog-trace-id')
      expect(carrier).to.not.have.property('x-datadog-parent-id')
      expect(carrier).to.not.have.property('x-datadog-sampling-priority')
    })

    it('should keep priority if standalone enabled and there is an appsec event', () => {
      standalone.configure(config, tracer)

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

      expect(carrier).to.have.property('x-datadog-trace-id')
      expect(carrier).to.have.property('x-datadog-parent-id')
      expect(carrier).to.have.property('x-datadog-sampling-priority')
      expect(carrier).to.have.property('x-datadog-tags', '_dd.p.appsec=1')
    })

    it('should not reset priority if standalone disabled', () => {
      delete config.appsec.standalone
      standalone.configure(config, tracer)

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

      expect(carrier).to.have.property('x-datadog-trace-id')
      expect(carrier).to.have.property('x-datadog-parent-id')
      expect(carrier).to.have.property('x-datadog-sampling-priority')
    })
  })

  /**
   *

function onSpanExtract ({ spanContext, carrier }) {
  // reset upstream priority if _dd.p.appsec is not found
  if (!hasOwn(spanContext._trace.tags, APPSEC_PROPAGATION_KEY)) {
    spanContext._sampling = {}
  } else if (spanContext._sampling.priority !== USER_KEEP) {
    spanContext._sampling.priority = USER_KEEP
  }
}
   */

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
        expect(prioritySampler._getPriorityFromTags(tags, context)).is.equal(USER_KEEP)
        expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_APPSEC)
      })

      it('should return undefined if manual.keep or _dd.p.appsec are not present', () => {
        expect(prioritySampler._getPriorityFromTags(tags, context)).is.undefined
      })
    })

    describe('_getPriorityFromAuto', () => {
      it('should keep one trace per 1 min', () => {
        const span = {
          _trace: {}
        }

        const clock = sinon.useFakeTimers(new Date())

        expect(prioritySampler._getPriorityFromAuto(span)).is.equal(AUTO_KEEP)
        expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_APPSEC)

        expect(prioritySampler._getPriorityFromAuto(span)).is.equal(AUTO_REJECT)

        clock.tick(30000)

        expect(prioritySampler._getPriorityFromAuto(span)).is.equal(AUTO_REJECT)

        clock.tick(60000)

        expect(prioritySampler._getPriorityFromAuto(span)).is.equal(AUTO_KEEP)

        clock.restore()
      })

      it('should keep trace if it contains _dd.p.appsec tag', () => {
        const span = {
          _trace: {}
        }

        context._trace.tags[APPSEC_PROPAGATION_KEY] = 1

        expect(prioritySampler._getPriorityFromAuto(span)).is.equal(USER_KEEP)
      })
    })
  })
})
