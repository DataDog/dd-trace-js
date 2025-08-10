'use strict'

const proxyquire = require('proxyquire')
const { handleUncaughtExceptionMonitor } = require('../../../src/appsec/rasp')
const { DatadogRaspAbortError } = require('../../../src/appsec/rasp/utils')

describe('RASP', () => {
  let rasp, channels, blocking, blocked, updateRaspRuleMatchMetricTags

  beforeEach(() => {
    const config = {
      appsec: {
        stackTrace: {
          enabled: true,
          maxStackTraces: 2,
          maxDepth: 42
        }
      }
    }

    channels = {
      expressMiddlewareError: {
        subscribe: sinon.stub(),
        unsubscribe: sinon.stub(),
        hasSubscribers: true
      },
      fastifyMiddlewareError: {
        subscribe: sinon.stub(),
        unsubscribe: sinon.stub(),
        hasSubscribers: true
      }
    }

    blocking = {
      block: sinon.stub().returns(true),
      delegateBlock: sinon.stub().resolves(true),
      isBlocked: sinon.stub().callsFake(() => blocked)
    }

    updateRaspRuleMatchMetricTags = sinon.stub()

    rasp = proxyquire('../../../src/appsec/rasp', {
      '../blocking': blocking,
      '../channels': channels,
      '../telemetry': {
        updateRaspRuleMatchMetricTags
      }
    })

    rasp.enable(config)
  })

  afterEach(() => {
    sinon.restore()
    rasp.disable()
  })

  describe('handleUncaughtExceptionMonitor', () => {
    it('should not break with infinite loop of cause', () => {
      const err = new Error()
      err.cause = err

      handleUncaughtExceptionMonitor(err)
    })
  })

  describe('enable/disable', () => {
    it('should subscribe to error channels', () => {
      sinon.assert.calledOnce(channels.expressMiddlewareError.subscribe)
      sinon.assert.calledOnce(channels.fastifyMiddlewareError.subscribe)
    })

    it('should unsubscribe from error channels', () => {
      rasp.disable()

      sinon.assert.calledOnce(channels.expressMiddlewareError.unsubscribe)
      sinon.assert.calledOnce(channels.fastifyMiddlewareError.unsubscribe)
    })
  })

  describe('blockOnDatadogRaspAbortError', () => {
    let req, res, blockingAction, raspRule

    beforeEach(() => {
      req = {}
      res = {}
      blockingAction = {}
      raspRule = { type: 'type' }
    })

    afterEach(() => {
      sinon.restore()
    })

    it('should skip non DatadogRaspAbortError', () => {
      rasp.blockOnDatadogRaspAbortError({ error: new Error() })

      sinon.assert.notCalled(blocking.block)
      sinon.assert.notCalled(blocking.delegateBlock)
      sinon.assert.notCalled(updateRaspRuleMatchMetricTags)
    })

    it('should block DatadogRaspAbortError first time and update metrics', (done) => {
      rasp.blockOnDatadogRaspAbortError({
        error: new DatadogRaspAbortError(req, res, blockingAction, raspRule, true)
      })

      sinon.assert.calledOnce(blocking.delegateBlock)

      setImmediate(() => {
        sinon.assert.calledOnceWithExactly(updateRaspRuleMatchMetricTags, req, raspRule, true, true)
        done()
      })
    })

    it('should skip calling block if blocked before', (done) => {
      rasp.blockOnDatadogRaspAbortError({
        error: new DatadogRaspAbortError(req, res, blockingAction, raspRule, true)
      })

      blocked = true

      rasp.blockOnDatadogRaspAbortError({
        error: new DatadogRaspAbortError(req, res, blockingAction, raspRule, true)
      })
      rasp.blockOnDatadogRaspAbortError({
        error: new DatadogRaspAbortError(req, res, blockingAction, raspRule, true)
      })

      sinon.assert.calledOnce(blocking.delegateBlock)

      setImmediate(() => {
        sinon.assert.calledOnce(updateRaspRuleMatchMetricTags)
        done()
      })
    })
  })
})
