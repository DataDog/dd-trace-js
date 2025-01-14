'use strict'

const proxyquire = require('proxyquire')

describe('RASP - utils.js', () => {
  let web, utils, stackTrace, config

  beforeEach(() => {
    web = {
      root: sinon.stub()
    }

    stackTrace = {
      reportStackTrace: sinon.stub(),
      getCallSiteList: sinon.stub().returns([])
    }

    utils = proxyquire('../../../src/appsec/rasp/utils', {
      '../../plugins/util/web': web,
      '../stack_trace': stackTrace
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

  describe('handleResult', () => {
    it('should report stack trace when generate_stack action is present in waf result', () => {
      const req = {}
      const rootSpan = {}
      const stackId = 'test_stack_id'
      const result = {
        generate_stack: {
          stack_id: stackId
        }
      }

      web.root.returns(rootSpan)

      utils.handleResult(result, req, undefined, undefined, config)
      sinon.assert.calledOnceWithExactly(stackTrace.reportStackTrace, rootSpan, stackId, 2, sinon.match.array)
    })

    it('should not report stack trace when no action is present in waf result', () => {
      const req = {}
      const result = {}

      utils.handleResult(result, req, undefined, undefined, config)
      sinon.assert.notCalled(stackTrace.reportStackTrace)
    })

    it('should not report stack trace when stack trace reporting is disabled', () => {
      const req = {}
      const result = {
        generate_stack: {
          stack_id: 'stackId'
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

      utils.handleResult(result, req, undefined, undefined, config)
      sinon.assert.notCalled(stackTrace.reportStackTrace)
    })
  })
})
