'use strict'

const proxyquire = require('proxyquire')

describe('RASP - utils.js', () => {
  let web, utils, stackTrace, config, telemetry
  const raspRule = { type: 'type', variant: 'variant' }
  const req = {}
  const res = {}

  beforeEach(() => {
    web = {
      root: sinon.stub()
    }

    stackTrace = {
      reportStackTrace: sinon.stub(),
      getCallsiteFrames: sinon.stub().returns([]),
      canReportStackTrace: sinon.stub().returns(false)
    }

    telemetry = {
      updateRaspRuleMatchMetricTags: sinon.stub()
    }

    utils = proxyquire('../../../src/appsec/rasp/utils', {
      '../../plugins/util/web': web,
      '../stack_trace': stackTrace,
      '../telemetry': telemetry,
      '../blocking': {
        getBlockingAction: sinon.spy((actions) => actions?.blocking_action)
      }
    })

    config = {
      appsec: {
        stackTrace: {
          enabled: true,
          maxStackTraces: 2,
          maxDepth: 42
        }
      }
    }
  })

  function testAbortErrorInFramework (framework) {
    const rootSpan = {
      context: sinon.stub().returns({ _name: framework })
    }
    const abortController = {
      abort: sinon.stub(),
      signal: {}
    }
    const result = {
      actions: {
        blocking_action: { type: 'block_request' }
      }
    }

    web.root.returns(rootSpan)

    utils.handleResult(result, req, res, abortController, config, raspRule)

    sinon.assert.calledOnce(abortController.abort)
    const abortError = abortController.abort.firstCall.args[0]
    expect(abortError).to.be.instanceOf(utils.DatadogRaspAbortError)
    expect(abortError.raspRule).to.equal(raspRule)
    expect(abortError.blockingAction).to.equal(result.actions.blocking_action)
  }

  describe('handleResult', () => {
    it('should report stack trace when generate_stack action is present in waf result', () => {
      const rootSpan = {}
      const stackId = 'test_stack_id'
      const result = {
        actions: {
          generate_stack: {
            stack_id: stackId
          }
        },
        events: [{ a: [1] }]
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
            exploit: ['stack1', 'stack2']
          }
        }
      }
      const result = {
        actions: {
          generate_stack: {
            stack_id: 'stackId'
          }
        }
      }

      web.root.returns(rootSpan)

      utils.handleResult(result, req, undefined, undefined, config, raspRule)
      sinon.assert.notCalled(stackTrace.reportStackTrace)
    })

    it('should not report stack trace when rootSpan is null', () => {
      const result = {
        generate_stack: {
          stack_id: 'stackId'
        }
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
            stack_id: 'stackId'
          }
        }
      }
      const config = {
        appsec: {
          stackTrace: {
            enabled: false,
            maxStackTraces: 2,
            maxDepth: 42
          }
        }
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
        context: sinon.stub().returns({ _name: 'http.request' })
      }
      const abortController = {
        abort: sinon.stub(),
        signal: {}
      }
      const result = {
        actions: {
          blocking_action: { type: 'block_request' }
        }
      }

      web.root.returns(rootSpan)

      utils.handleResult(result, req, res, abortController, config, raspRule)

      sinon.assert.notCalled(abortController.abort)
    })

    it('should call updateRaspRuleMatchMetricTags when no blockingAction is present', () => {
      const rootSpan = {}
      const abortController = {
        abort: sinon.stub(),
        signal: {}
      }
      const result = {
        events: [{ a: [1] }]
      }

      web.root.returns(rootSpan)

      utils.handleResult(result, req, res, abortController, config, raspRule)

      sinon.assert.notCalled(abortController.abort)
      sinon.assert.calledOnceWithExactly(telemetry.updateRaspRuleMatchMetricTags, req, raspRule, false, false)
    })
  })

  describe('DatadogRaspAbortError', () => {
    it('should store all provided parameters', () => {
      const blockingAction = { type: 'block_request' }

      const error = new utils.DatadogRaspAbortError(req, res, blockingAction, raspRule)

      expect(error.name).to.equal('DatadogRaspAbortError')
      expect(error.message).to.equal('DatadogRaspAbortError')
      expect(error.blockingAction).to.equal(blockingAction)
      expect(error.raspRule).to.equal(raspRule)
      expect(error).to.have.property('req')
      expect(error).to.have.property('res')
      expect(Object.keys(error)).to.not.include.members(['req', 'res'])
    })
  })
})
