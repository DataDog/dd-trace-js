'use strict'

const { channel } = require('dc-polyfill')
const { assert } = require('chai')
const standalone = require('../../src/appsec/standalone')
const DatadogSpan = require('../../src/opentracing/span')
const { APM_TRACING_ENABLED_KEY } = require('../../src/constants')

const startCh = channel('dd-trace:span:start')

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

      sinon.assert.calledOnce(startChSubscribe)
    })

    it('should not subscribe to start span if standalone disabled', () => {
      delete config.appsec.standalone

      standalone.configure(config)

      sinon.assert.calledOnce(startChUnsubscribe)
    })

    it('should subscribe only once', () => {
      standalone.configure(config)
      standalone.configure(config)
      standalone.configure(config)

      sinon.assert.calledOnce(startChSubscribe)
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
})
