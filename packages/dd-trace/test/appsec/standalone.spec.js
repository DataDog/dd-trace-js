'use strict'

const { channel } = require('dc-polyfill')
const startCh = channel('dd-trace:span:start')

const standalone = require('../../src/appsec/standalone')
const DatadogSpan = require('../../src/opentracing/span')
const { APM_TRACING_ENABLED_KEY } = require('../../src/constants')

describe('Appsec Standalone', () => {
  let config
  let tracer, processor, prioritySampler

  beforeEach(() => {
    config = { appsec: { standalone: { enabled: true } } }

    tracer = {}
    processor = {}
    prioritySampler = {}
  })

  afterEach(() => { sinon.restore() })

  describe('configure', () => {
    let startChSubscribe
    let startChUnsubscribe

    beforeEach(() => {
      startChSubscribe = sinon.stub(startCh, 'subscribe')
      startChUnsubscribe = sinon.stub(startCh, 'unsubscribe')
    })

    it('should subscribe to start span if standalone enabled', () => {
      standalone.configure(config)

      expect(startChSubscribe).to.be.calledOnce
    })

    it('should not subscribe to start span if standalone disabled', () => {
      delete config.appsec.standalone

      standalone.configure(config)

      expect(startChUnsubscribe).to.be.calledOnce
    })

    it('should subscribe only once', () => {
      standalone.configure(config)
      standalone.configure(config)
      standalone.configure(config)

      expect(startChSubscribe).to.be.calledOnce
    })
  })

  describe('onStartSpan', () => {
    it('should not add _dd.apm.enabled tag when standalone is disabled', () => {
      delete config.appsec.standalone
      standalone.configure(config)

      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation'
      })

      expect(span.context()._tags).to.not.have.property(APM_TRACING_ENABLED_KEY)
    })

    it('should add _dd.apm.enabled tag when standalone is enabled', () => {
      standalone.configure(config)

      const span = new DatadogSpan(tracer, processor, prioritySampler, {
        operationName: 'operation'
      })

      expect(span.context()._tags).to.have.property(APM_TRACING_ENABLED_KEY)
    })

    it('should not add _dd.apm.enabled tag in child spans with local parent', () => {
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
})
