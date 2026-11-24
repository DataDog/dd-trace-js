'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { DatadogRaspAbortError } = require('../../../src/appsec/rasp/utils')

describe('RASP', () => {
  let rasp, channels, blocking, blocked, updateRaspRuleMatchMetricTags, utils

  beforeEach(() => {
    const config = {
      appsec: {
        DD_APPSEC_STACK_TRACE_ENABLED: true,
        DD_APPSEC_MAX_STACK_TRACES: 2,
        DD_APPSEC_MAX_STACK_TRACE_DEPTH: 42,
      },
    }

    channels = {
      expressMiddlewareError: {
        subscribe: sinon.stub(),
        unsubscribe: sinon.stub(),
        hasSubscribers: true,
      },
      fastifyMiddlewareError: {
        subscribe: sinon.stub(),
        unsubscribe: sinon.stub(),
        hasSubscribers: true,
      },
      routerMiddlewareError: {
        subscribe: sinon.stub(),
        unsubscribe: sinon.stub(),
        hasSubscribers: true,
      },
      nextRequestStart: {
        subscribe: sinon.stub(),
        unsubscribe: sinon.stub(),
        hasSubscribers: true,
      },
    }

    blocked = false

    blocking = {
      block: sinon.stub().returns(true),
      registerBlockDelegation: sinon.stub().resolves(true),
      isBlocked: sinon.stub().callsFake(() => blocked),
    }

    updateRaspRuleMatchMetricTags = sinon.stub()

    utils = {
      markToBlockOnDetection: sinon.stub(),
      hasBlockingAbort: sinon.stub().returns(false),
    }

    rasp = proxyquire('../../../src/appsec/rasp', {
      '../blocking': blocking,
      '../channels': channels,
      '../telemetry': {
        updateRaspRuleMatchMetricTags,
      },
      './utils': utils,
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

      rasp.handleUncaughtExceptionMonitor(err)
    })
  })

  describe('enable/disable', () => {
    it('should subscribe to error channels', () => {
      sinon.assert.calledOnce(channels.expressMiddlewareError.subscribe)
      sinon.assert.calledOnce(channels.fastifyMiddlewareError.subscribe)
      sinon.assert.calledOnce(channels.routerMiddlewareError.subscribe)
    })

    it('should unsubscribe from error channels', () => {
      rasp.disable()

      sinon.assert.calledOnce(channels.expressMiddlewareError.unsubscribe)
      sinon.assert.calledOnce(channels.fastifyMiddlewareError.unsubscribe)
      sinon.assert.calledOnce(channels.routerMiddlewareError.unsubscribe)
    })

    it('should block Next.js requests on detection', () => {
      const req = {}
      const ignoreError = sinon.stub()

      sinon.assert.calledOnce(channels.nextRequestStart.subscribe)
      channels.nextRequestStart.subscribe.firstCall.args[0]({ req, ignoreError })

      sinon.assert.calledOnceWithExactly(utils.markToBlockOnDetection, req, ignoreError)
    })

    it('should unsubscribe from the Next.js request start channel', () => {
      rasp.disable()

      sinon.assert.calledOnceWithExactly(
        channels.nextRequestStart.unsubscribe,
        channels.nextRequestStart.subscribe.firstCall.args[0]
      )
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
      sinon.assert.notCalled(blocking.registerBlockDelegation)
      sinon.assert.notCalled(updateRaspRuleMatchMetricTags)
    })

    it('should block DatadogRaspAbortError first time and update metrics', (done) => {
      rasp.blockOnDatadogRaspAbortError({
        error: new DatadogRaspAbortError(req, res, blockingAction, raspRule, true),
      })

      sinon.assert.calledOnce(blocking.registerBlockDelegation)

      setImmediate(() => {
        sinon.assert.calledOnceWithExactly(updateRaspRuleMatchMetricTags, req, raspRule, true, true)
        done()
      })
    })

    it('should skip calling block if blocked before', (done) => {
      rasp.blockOnDatadogRaspAbortError({
        error: new DatadogRaspAbortError(req, res, blockingAction, raspRule, true),
      })

      blocked = true

      rasp.blockOnDatadogRaspAbortError({
        error: new DatadogRaspAbortError(req, res, blockingAction, raspRule, true),
      })
      rasp.blockOnDatadogRaspAbortError({
        error: new DatadogRaspAbortError(req, res, blockingAction, raspRule, true),
      })

      sinon.assert.calledOnce(blocking.registerBlockDelegation)

      setImmediate(() => {
        sinon.assert.calledOnce(updateRaspRuleMatchMetricTags)
        done()
      })
    })

    it('should block without delegate when called by handleUncaughtExceptionMonitor', (done) => {
      rasp.handleUncaughtExceptionMonitor(new DatadogRaspAbortError(req, res, blockingAction, raspRule, true))

      sinon.assert.calledOnce(blocking.block)

      setImmediate(() => {
        sinon.assert.calledOnceWithExactly(updateRaspRuleMatchMetricTags, req, raspRule, true, true)
        done()
      })
    })

    describe('when a library wraps the abort error', () => {
      let abortError

      beforeEach(() => {
        abortError = new DatadogRaspAbortError(req, res, blockingAction, raspRule, true)
        utils.hasBlockingAbort.withArgs(req).returns(true)
      })

      /**
       * Wraps `last` in `length` errors, each one holding the next one in a property.
       *
       * @param {number} length
       * @param {Error} last
       */
      function chainOfErrors (length, last) {
        let error = last
        for (let i = 0; i < length; i++) {
          error = Object.assign(new Error(`wrapper ${i}`), { previous: error })
        }
        return error
      }

      function assertBlocked () {
        sinon.assert.calledOnceWithExactly(
          blocking.registerBlockDelegation, req, res, sinon.match.any, null, blockingAction
        )
      }

      function assertNotBlocked () {
        sinon.assert.notCalled(blocking.registerBlockDelegation)
        sinon.assert.notCalled(blocking.block)
      }

      it('should block when a property of the error holds the abort error', async () => {
        const error = Object.assign(new Error('Wrapped'), { parent: abortError, original: abortError })

        assert.strictEqual(rasp.blockOnDatadogRaspAbortError({ error, req }), true)

        assertBlocked()
        await new Promise(resolve => setImmediate(resolve))
        sinon.assert.calledOnceWithExactly(updateRaspRuleMatchMetricTags, req, raspRule, true, true)
      })

      it('should block when a non-enumerable property of the error holds the abort error', () => {
        const error = Object.defineProperty(new Error('Wrapped'), 'driverError', { value: abortError })

        rasp.blockOnDatadogRaspAbortError({ error, req })

        assertBlocked()
      })

      it('should block when the abort error is held by an error in the cause of the error', () => {
        const error = new Error('Application', { cause: Object.assign(new Error('Library'), { parent: abortError }) })

        rasp.blockOnDatadogRaspAbortError({ error, req })

        assertBlocked()
      })

      it('should block when the abort error is held by the tenth error walked', () => {
        rasp.blockOnDatadogRaspAbortError({ error: chainOfErrors(10, abortError), req })

        assertBlocked()
      })

      it('should not block when the abort error is held by the eleventh error walked', () => {
        rasp.blockOnDatadogRaspAbortError({ error: chainOfErrors(11, abortError), req })

        assertNotBlocked()
      })

      it('should not block when the request has no blocking abort', () => {
        utils.hasBlockingAbort.withArgs(req).returns(false)
        const error = Object.assign(new Error('Wrapped'), { parent: abortError })

        assert.strictEqual(rasp.blockOnDatadogRaspAbortError({ error, req }), false)

        assertNotBlocked()
      })

      it('should not block with the abort error of another request', () => {
        const otherAbortError = new DatadogRaspAbortError({}, {}, blockingAction, raspRule, true)
        const error = Object.assign(new Error('Wrapped'), { parent: otherAbortError })

        rasp.blockOnDatadogRaspAbortError({ error, req })

        assertNotBlocked()
      })

      it('should not format the stack traces of the errors it walks', () => {
        const { prepareStackTrace } = Error
        const formatStackTrace = sinon.stub().returns('formatted')
        Error.prepareStackTrace = formatStackTrace
        try {
          const library = Object.assign(new Error('Library'), { parent: abortError })
          const error = Object.assign(new Error('Wrapped'), { library })

          rasp.blockOnDatadogRaspAbortError({ error, req })
        } finally {
          Error.prepareStackTrace = prepareStackTrace
        }

        sinon.assert.notCalled(formatStackTrace)
        assertBlocked()
      })

      it('should not call the getters of the error', () => {
        const get = sinon.stub().returns(abortError)
        const error = Object.defineProperty(new Error('Wrapped'), 'parent', { get })

        rasp.blockOnDatadogRaspAbortError({ error, req })

        sinon.assert.notCalled(get)
        assertNotBlocked()
      })

      it('should not walk objects that are not native errors', () => {
        const ownKeys = sinon.stub().returns([])
        const proxy = new Proxy(Object.assign(new Error('Wrapped'), { parent: abortError }), { ownKeys })
        const error = Object.assign(new Error('Wrapped'), { proxy })

        rasp.blockOnDatadogRaspAbortError({ error: proxy, req })
        rasp.blockOnDatadogRaspAbortError({ error, req })
        rasp.blockOnDatadogRaspAbortError({ error: { parent: abortError }, req })

        sinon.assert.notCalled(ownKeys)
        assertNotBlocked()
      })

      it('should stop walking an error that holds itself', () => {
        const error = new Error('Wrapped')
        error.self = error

        assert.strictEqual(rasp.blockOnDatadogRaspAbortError({ error, req }), false)

        assertNotBlocked()
      })
    })
  })
})
