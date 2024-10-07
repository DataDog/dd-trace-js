'use strict'

const proxyquire = require('proxyquire')
const { expressMiddlewareError } = require('../../../src/appsec/channels')
const rasp = require('../../../src/appsec/rasp')
const { handleUncaughtExceptionMonitor } = require('../../../src/appsec/rasp')
const { DatadogRaspAbortError } = require('../../../src/appsec/rasp/utils')

describe('RASP', () => {
  let onErrorSub, onErrorUnsub, block

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

    onErrorSub = sinon.spy(expressMiddlewareError, 'subscribe')
    onErrorUnsub = sinon.spy(expressMiddlewareError, 'unsubscribe')

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
      sinon.assert.calledOnce(onErrorSub)
    })

    it('should unsubscribe to apm:express:middleware:error', () => {
      rasp.disable()

      sinon.assert.calledOnce(onErrorUnsub)
    })
  })

  describe('blockOnDatadogRaspAbortError', () => {
    let rasp, req, res, blockingAction, blocked

    beforeEach(() => {
      req = {}
      res = {}
      blockingAction = 'block'
      block = sinon.stub()

      rasp = proxyquire('../../../src/appsec/rasp', {
        '../blocking': {
          block,
          isBlocked: sinon.stub().callsFake(() => blocked)
        }
      })
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
