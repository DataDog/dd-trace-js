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
      block: sinon.stub().returns(true),
      isBlocked: sinon.stub().returns(false),
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
    sinon.assert.notCalled(blocking.block)
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

    it('should record the request of a blocking abort', () => {
      assert.strictEqual(utils.hasBlockingAbort(req), false)

      testAbortErrorInFramework('express.request')

      assert.strictEqual(utils.hasBlockingAbort(req), true)
      assert.strictEqual(utils.hasBlockingAbort({}), false)
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
      assert.strictEqual(utils.hasBlockingAbort(req), false)
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

    let rootSpan, abortController, ignoreError

    beforeEach(() => {
      rootSpan = {
        context: sinon.stub().returns({ _name: 'web.request' }),
      }
      abortController = {
        abort: sinon.stub(),
        signal: {},
      }
      ignoreError = sinon.stub()

      web.root.returns(rootSpan)
      utils.markToBlockOnDetection(req, ignoreError)
    })

    it('should block the request before aborting the operation', () => {
      utils.handleResult(result, req, res, abortController, config, raspRule)

      sinon.assert.calledOnceWithExactly(blocking.block, req, res, rootSpan, null, blockingAction)
      sinon.assert.calledOnce(abortController.abort)
      sinon.assert.callOrder(blocking.block, abortController.abort)

      const abortError = abortController.abort.firstCall.args[0]
      assert.ok(abortError instanceof utils.DatadogRaspAbortError)
      assert.strictEqual(abortError.req, req)
      assert.strictEqual(abortError.res, res)
      assert.strictEqual(abortError.blockingAction, blockingAction)
      assert.strictEqual(abortError.raspRule, raspRule)

      sinon.assert.calledOnceWithExactly(telemetry.updateRaspRuleMatchMetricTags, req, raspRule, true, true)
    })

    it('should let the framework ignore the abort error of a blocked request before aborting', () => {
      utils.handleResult(result, req, res, abortController, config, raspRule)

      const abortError = abortController.abort.firstCall.args[0]
      sinon.assert.calledOnceWithExactly(ignoreError, abortError)
      sinon.assert.callOrder(blocking.block, ignoreError, abortController.abort)
    })

    it('should abort without ignoring the abort error when the blocking response fails', () => {
      blocking.block.returns(false)

      utils.handleResult(result, req, res, abortController, config, raspRule)

      sinon.assert.calledOnce(blocking.block)
      sinon.assert.calledOnce(abortController.abort)
      sinon.assert.notCalled(ignoreError)
      sinon.assert.calledOnceWithExactly(telemetry.updateRaspRuleMatchMetricTags, req, raspRule, true, false)
    })

    it('should abort without blocking again a request that is already blocked', () => {
      blocking.isBlocked.withArgs(res).returns(true)

      utils.handleResult(result, req, res, abortController, config, raspRule)

      sinon.assert.notCalled(blocking.block)
      sinon.assert.calledOnce(abortController.abort)
      sinon.assert.calledOnceWithExactly(ignoreError, abortController.abort.firstCall.args[0])
      sinon.assert.calledOnceWithExactly(telemetry.updateRaspRuleMatchMetricTags, req, raspRule, true, true)
    })

    it('should report every rule match of a request blocked by an earlier one', () => {
      blocking.isBlocked.withArgs(res).onSecondCall().returns(true)

      utils.handleResult(result, req, res, abortController, config, raspRule)
      utils.handleResult(result, req, res, abortController, config, raspRule)

      sinon.assert.calledOnce(blocking.block)
      sinon.assert.calledTwice(abortController.abort)
      sinon.assert.calledTwice(ignoreError)
      sinon.assert.alwaysCalledWithExactly(telemetry.updateRaspRuleMatchMetricTags, req, raspRule, true, true)
      sinon.assert.calledTwice(telemetry.updateRaspRuleMatchMetricTags)
    })

    it('should abort without blocking when there is no response to block', () => {
      utils.handleResult(result, req, undefined, abortController, config, raspRule)

      sinon.assert.notCalled(blocking.block)
      sinon.assert.calledOnce(abortController.abort)
      sinon.assert.notCalled(ignoreError)
      sinon.assert.calledOnceWithExactly(telemetry.updateRaspRuleMatchMetricTags, req, raspRule, true, false)
    })

    it('should block when the root span is an Express request', () => {
      rootSpan.context.returns({ _name: 'express.request' })

      utils.handleResult(result, req, res, abortController, config, raspRule)

      sinon.assert.calledOnceWithExactly(blocking.block, req, res, rootSpan, null, blockingAction)
      sinon.assert.calledOnce(abortController.abort)
    })

    it('should not ignore any error when the rule does not block', () => {
      utils.handleResult({ events: result.events }, req, res, abortController, config, raspRule)

      sinon.assert.notCalled(ignoreError)
    })

    it('should not abort or block without a blocking action', () => {
      utils.handleResult({ events: result.events }, req, res, abortController, config, raspRule)

      sinon.assert.notCalled(abortController.abort)
      sinon.assert.notCalled(blocking.block)
      sinon.assert.calledOnceWithExactly(telemetry.updateRaspRuleMatchMetricTags, req, raspRule, false, false)
    })

    it('should not block without an abort controller', () => {
      utils.handleResult(result, req, res, undefined, config, raspRule)

      sinon.assert.notCalled(blocking.block)
      sinon.assert.calledOnceWithExactly(telemetry.updateRaspRuleMatchMetricTags, req, raspRule, false, false)
    })

    it('should not abort or block in a request that is not blocked on detection', () => {
      utils.handleResult(result, {}, res, abortController, config, raspRule)

      sinon.assert.notCalled(abortController.abort)
      sinon.assert.notCalled(blocking.block)
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
