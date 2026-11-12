'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('RASP - utils.js', () => {
  let web, utils, stackTrace, config, telemetry, blocking
  const raspRule = { type: 'type', variant: 'variant' }
  const req = {}
  const res = {}

  beforeEach(() => {
    web = {
      root: sinon.stub(),
    }

    stackTrace = {
      reportStackTrace: sinon.stub(),
      getCallsiteFrames: sinon.stub().returns([]),
      canReportStackTrace: sinon.stub().returns(false),
    }

    telemetry = {
      updateRaspRuleMatchMetricTags: sinon.stub(),
    }

    blocking = {
      getBlockingAction: sinon.spy((actions) => actions?.blocking_action),
      registerBlockDelegation: sinon.stub().resolves(true),
    }

    utils = proxyquire('../../../src/appsec/rasp/utils', {
      '../../plugins/util/web': web,
      '../stack_trace': stackTrace,
      '../telemetry': telemetry,
      '../blocking': blocking,
    })

    config = {
      appsec: {
        DD_APPSEC_STACK_TRACE_ENABLED: true,
        DD_APPSEC_MAX_STACK_TRACES: 2,
        DD_APPSEC_MAX_STACK_TRACE_DEPTH: 42,
      },
    }
  })

  function testAbortErrorInFramework (framework) {
    const rootSpan = {
      context: sinon.stub().returns({ _name: framework }),
    }
    const abortController = {
      abort: sinon.stub(),
      signal: {},
    }
    const result = {
      actions: {
        blocking_action: { type: 'block_request' },
      },
    }

    web.root.returns(rootSpan)

    utils.handleResult(result, req, res, abortController, config, raspRule)

    sinon.assert.calledOnce(abortController.abort)
    const abortError = abortController.abort.firstCall.args[0]
    assert.ok(abortError instanceof utils.DatadogRaspAbortError)
    assert.strictEqual(abortError.raspRule, raspRule)
    assert.strictEqual(abortError.blockingAction, result.actions.blocking_action)
    sinon.assert.notCalled(blocking.registerBlockDelegation)
  }

  describe('handleResult', () => {
    it('should report stack trace when generate_stack action is present in waf result', () => {
      const rootSpan = {}
      const stackId = 'test_stack_id'
      const result = {
        actions: {
          generate_stack: {
            stack_id: stackId,
          },
        },
        events: [{ a: [1] }],
      }

      web.root.returns(rootSpan)
      stackTrace.canReportStackTrace.returns(true)

      utils.handleResult(result, req, undefined, undefined, config, raspRule)
      sinon.assert.calledOnceWithExactly(stackTrace.reportStackTrace, rootSpan, stackId, sinon.match.array)
    })

    it('should not report stack trace when max stack traces limit is reached', () => {
      const rootSpan = {
        meta_struct: {
          '_dd.stack': {
            exploit: ['stack1', 'stack2'],
          },
        },
      }
      const result = {
        actions: {
          generate_stack: {
            stack_id: 'stackId',
          },
        },
      }

      web.root.returns(rootSpan)

      utils.handleResult(result, req, undefined, undefined, config, raspRule)
      sinon.assert.notCalled(stackTrace.reportStackTrace)
    })

    it('should not report stack trace when rootSpan is null', () => {
      const result = {
        generate_stack: {
          stack_id: 'stackId',
        },
      }

      web.root.returns(null)

      utils.handleResult(result, req, undefined, undefined, config, raspRule)
      sinon.assert.notCalled(stackTrace.reportStackTrace)
    })

    it('should not report stack trace when no action is present in waf result', () => {
      const result = {}

      utils.handleResult(result, req, undefined, undefined, config, raspRule)
      sinon.assert.notCalled(stackTrace.reportStackTrace)
    })

    it('should not report stack trace when stack trace reporting is disabled', () => {
      const result = {
        actions: {
          generate_stack: {
            stack_id: 'stackId',
          },
        },
      }
      const config = {
        appsec: {
          DD_APPSEC_STACK_TRACE_ENABLED: false,
          DD_APPSEC_MAX_STACK_TRACES: 2,
          DD_APPSEC_MAX_STACK_TRACE_DEPTH: 42,
        },
      }

      utils.handleResult(result, req, undefined, undefined, config, raspRule)
      sinon.assert.notCalled(stackTrace.reportStackTrace)
    })

    it('should create DatadogRaspAbortError when blockingAction is present in express', () => {
      testAbortErrorInFramework('express.request')
    })

    it('should create DatadogRaspAbortError when blockingAction is present in fastify', () => {
      testAbortErrorInFramework('fastify.request')
    })

    it('should not create DatadogRaspAbortError when blockingAction is present in an unsupported framework', () => {
      const rootSpan = {
        context: sinon.stub().returns({ _name: 'http.request' }),
      }
      const abortController = {
        abort: sinon.stub(),
        signal: {},
      }
      const result = {
        actions: {
          blocking_action: { type: 'block_request' },
        },
      }

      web.root.returns(rootSpan)

      utils.handleResult(result, req, res, abortController, config, raspRule)

      sinon.assert.notCalled(abortController.abort)
    })

    it('should call updateRaspRuleMatchMetricTags when no blockingAction is present', () => {
      const rootSpan = {}
      const abortController = {
        abort: sinon.stub(),
        signal: {},
      }
      const result = {
        events: [{ a: [1] }],
      }

      web.root.returns(rootSpan)

      utils.handleResult(result, req, res, abortController, config, raspRule)

      sinon.assert.notCalled(abortController.abort)
      sinon.assert.calledOnceWithExactly(telemetry.updateRaspRuleMatchMetricTags, req, raspRule, false, false)
    })
  })

  describe('handleResult in a request blocked on detection', () => {
    const blockingAction = { type: 'block_request' }
    const result = {
      actions: {
        blocking_action: blockingAction,
      },
      events: [{ a: [1] }],
    }

    let rootSpan, abortController

    beforeEach(() => {
      rootSpan = {
        context: sinon.stub().returns({ _name: 'web.request' }),
      }
      abortController = {
        abort: sinon.stub(),
        signal: {},
      }

      web.root.returns(rootSpan)
      utils.markToBlockOnDetection(req)
    })

    it('should abort the operation and delegate the blocking response', async () => {
      utils.handleResult(result, req, res, abortController, config, raspRule)

      sinon.assert.calledOnceWithExactly(blocking.registerBlockDelegation, req, res, rootSpan, null, blockingAction)
      sinon.assert.calledOnce(abortController.abort)
      sinon.assert.callOrder(blocking.registerBlockDelegation, abortController.abort)

      const abortError = abortController.abort.firstCall.args[0]
      assert.ok(abortError instanceof utils.DatadogRaspAbortError)
      assert.strictEqual(abortError.req, req)
      assert.strictEqual(abortError.res, res)
      assert.strictEqual(abortError.blockingAction, blockingAction)
      assert.strictEqual(abortError.raspRule, raspRule)

      sinon.assert.notCalled(telemetry.updateRaspRuleMatchMetricTags)

      await blocking.registerBlockDelegation.firstCall.returnValue

      sinon.assert.calledOnceWithExactly(telemetry.updateRaspRuleMatchMetricTags, req, raspRule, true, true)
    })

    it('should report the rule match as not blocked when the blocking response fails', async () => {
      blocking.registerBlockDelegation.resolves(false)

      utils.handleResult(result, req, res, abortController, config, raspRule)

      await blocking.registerBlockDelegation.firstCall.returnValue

      sinon.assert.calledOnceWithExactly(telemetry.updateRaspRuleMatchMetricTags, req, raspRule, true, false)
    })

    it('should delegate the blocking response when the root span is an Express request', () => {
      rootSpan.context.returns({ _name: 'express.request' })

      utils.handleResult(result, req, res, abortController, config, raspRule)

      sinon.assert.calledOnceWithExactly(blocking.registerBlockDelegation, req, res, rootSpan, null, blockingAction)
      sinon.assert.calledOnce(abortController.abort)
    })

    it('should not abort or delegate without a blocking action', () => {
      utils.handleResult({ events: result.events }, req, res, abortController, config, raspRule)

      sinon.assert.notCalled(abortController.abort)
      sinon.assert.notCalled(blocking.registerBlockDelegation)
      sinon.assert.calledOnceWithExactly(telemetry.updateRaspRuleMatchMetricTags, req, raspRule, false, false)
    })

    it('should not delegate the blocking response without an abort controller', () => {
      utils.handleResult(result, req, res, undefined, config, raspRule)

      sinon.assert.notCalled(blocking.registerBlockDelegation)
      sinon.assert.calledOnceWithExactly(telemetry.updateRaspRuleMatchMetricTags, req, raspRule, false, false)
    })

    it('should report a failed block when there is no response to block', async () => {
      const { getBlockingAction } = blocking
      const utilsWithRealDelegation = proxyquire('../../../src/appsec/rasp/utils', {
        '../../plugins/util/web': web,
        '../stack_trace': stackTrace,
        '../telemetry': telemetry,
        '../blocking': { getBlockingAction },
      })
      utilsWithRealDelegation.markToBlockOnDetection(req)

      utilsWithRealDelegation.handleResult(result, req, undefined, abortController, config, raspRule)

      sinon.assert.calledOnce(abortController.abort)

      await new Promise(resolve => setImmediate(resolve))

      sinon.assert.calledOnceWithExactly(telemetry.updateRaspRuleMatchMetricTags, req, raspRule, true, false)
    })

    it('should not abort or delegate in a request that is not blocked on detection', () => {
      utils.handleResult(result, {}, res, abortController, config, raspRule)

      sinon.assert.notCalled(abortController.abort)
      sinon.assert.notCalled(blocking.registerBlockDelegation)
    })
  })

  describe('DatadogRaspAbortError', () => {
    it('should store all provided parameters', () => {
      const blockingAction = { type: 'block_request' }

      const error = new utils.DatadogRaspAbortError(req, res, blockingAction, raspRule)

      assert.strictEqual(error.name, 'DatadogRaspAbortError')
      assert.strictEqual(error.message, 'DatadogRaspAbortError')
      assert.strictEqual(error.blockingAction, blockingAction)
      assert.strictEqual(error.raspRule, raspRule)
      assert.strictEqual(Object.getOwnPropertyDescriptor(error, 'req')?.enumerable, false)
      assert.strictEqual(Object.getOwnPropertyDescriptor(error, 'res')?.enumerable, false)
    })
  })
})
