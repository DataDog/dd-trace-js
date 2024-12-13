'use strict'

const proxyquire = require('proxyquire')
const { handleUncaughtExceptionMonitor } = require('../../../src/appsec/rasp')
const { DatadogRaspAbortError } = require('../../../src/appsec/rasp/utils')

describe('RASP', () => {
  let rasp, subscribe, unsubscribe, block, blocked

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

    subscribe = sinon.stub()
    unsubscribe = sinon.stub()

    block = sinon.stub()

    rasp = proxyquire('../../../src/appsec/rasp', {
      '../blocking': {
        block,
        isBlocked: sinon.stub().callsFake(() => blocked)
      },
      '../channels': {
        expressMiddlewareError: {
          subscribe,
          unsubscribe,
          hasSubscribers: true
        }
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
    it('should subscribe to apm:express:middleware:error', () => {
      sinon.assert.calledOnce(subscribe)
    })

    it('should unsubscribe to apm:express:middleware:error', () => {
      rasp.disable()

      sinon.assert.calledOnce(unsubscribe)
    })
  })

  describe('blockOnDatadogRaspAbortError', () => {
    let req, res, blockingAction

    beforeEach(() => {
      req = {}
      res = {}
      blockingAction = {}
    })

    afterEach(() => {
      sinon.restore()
    })

    it('should skip non DatadogRaspAbortError', () => {
      rasp.blockOnDatadogRaspAbortError({ error: new Error() })

      sinon.assert.notCalled(block)
    })

    it('should block DatadogRaspAbortError first time', () => {
      rasp.blockOnDatadogRaspAbortError({ error: new DatadogRaspAbortError(req, res, blockingAction) })

      sinon.assert.calledOnce(block)
    })

    it('should skip calling block if blocked before', () => {
      rasp.blockOnDatadogRaspAbortError({ error: new DatadogRaspAbortError(req, res, blockingAction) })

      blocked = true

      rasp.blockOnDatadogRaspAbortError({ error: new DatadogRaspAbortError(req, res, blockingAction) })
      rasp.blockOnDatadogRaspAbortError({ error: new DatadogRaspAbortError(req, res, blockingAction) })

      sinon.assert.calledOnce(block)
    })
  })
})
