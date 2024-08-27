'use strict'

const proxyquire = require('proxyquire')
const { httpClientRequestStart, fsOperationStart } = require('../../src/appsec/channels')
const addresses = require('../../src/appsec/addresses')
const { handleUncaughtExceptionMonitor } = require('../../src/appsec/rasp')

describe('RASP', () => {
  let waf, rasp, datadogCore, stackTrace, web, blocking

  beforeEach(() => {
    datadogCore = {
      storage: {
        getStore: sinon.stub()
      }
    }
    waf = {
      run: sinon.stub()
    }

    stackTrace = {
      reportStackTrace: sinon.stub()
    }

    web = {
      root: sinon.stub()
    }

    blocking = {
      block: sinon.stub()
    }

    rasp = proxyquire('../../src/appsec/rasp', {
      '../../../datadog-core': datadogCore,
      './waf': waf,
      './stack_trace': stackTrace,
      './../plugins/util/web': web,
      './blocking': blocking
    })

    const config = {
      appsec: {
        stackTrace: {
          enabled: true,
          maxStackTraces: 2,
          maxDepth: 42
        }
      }
    }

    rasp.enable(config)
  })

  afterEach(() => {
    sinon.restore()
    rasp.disable()
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

      rasp.handleResult(result, req)
      sinon.assert.calledOnceWithExactly(stackTrace.reportStackTrace, rootSpan, stackId, 42, 2)
    })

    it('should not report stack trace when no action is present in waf result', () => {
      const req = {}
      const result = {}

      rasp.handleResult(result, req)
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

      rasp.enable(config)

      rasp.handleResult(result, req)
      sinon.assert.notCalled(stackTrace.reportStackTrace)
    })
  })

  describe('analyzeSsrf', () => {
    it('should analyze ssrf', () => {
      const ctx = {
        args: {
          uri: 'http://example.com'
        }
      }
      const req = {}
      datadogCore.storage.getStore.returns({ req })

      httpClientRequestStart.publish(ctx)

      const persistent = { [addresses.HTTP_OUTGOING_URL]: 'http://example.com' }
      sinon.assert.calledOnceWithExactly(waf.run, { persistent }, req, 'ssrf')
    })

    it('should not analyze ssrf if rasp is disabled', () => {
      rasp.disable()
      const ctx = {
        args: {
          uri: 'http://example.com'
        }
      }
      const req = {}
      datadogCore.storage.getStore.returns({ req })

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze ssrf if no store', () => {
      const ctx = {
        args: {
          uri: 'http://example.com'
        }
      }
      datadogCore.storage.getStore.returns(undefined)

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze ssrf if no req', () => {
      const ctx = {
        args: {
          uri: 'http://example.com'
        }
      }
      datadogCore.storage.getStore.returns({})

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should not analyze ssrf if no url', () => {
      const ctx = {
        args: {}
      }
      datadogCore.storage.getStore.returns({})

      httpClientRequestStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })
  })

  describe('analyzeLfi', () => {
    const path = '/etc/passwd'
    const ctx = { path }
    const req = {}
    const res = {}

    it('should analyze lfi for root fs operations', () => {
      const fs = { root: true }
      datadogCore.storage.getStore.returns({ req, fs })

      fsOperationStart.publish(ctx)

      const persistent = { [addresses.FS_OPERATION_PATH]: path }
      sinon.assert.calledOnceWithExactly(waf.run, { persistent }, req, 'lfi')
    })

    it('should NOT analyze lfi for child fs operations', () => {
      const fs = {}
      datadogCore.storage.getStore.returns({ req, fs })

      fsOperationStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should NOT analyze lfi for undefined fs (AppsecFsPlugin disabled)', () => {
      const fs = undefined
      datadogCore.storage.getStore.returns({ req, fs })

      fsOperationStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should NOT analyze lfi for excluded operations', () => {
      const fs = { opExcluded: true, root: true }
      datadogCore.storage.getStore.returns({ req, fs })

      fsOperationStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should block req if there is a block_request action', () => {
      const fs = { root: true }
      datadogCore.storage.getStore.returns({ req, res, fs })

      const blockingAction = {
        block_request: {}
      }
      waf.run.returns(blockingAction)

      const rootSpan = {
        context: () => {
          return { _name: 'express.request' }
        }
      }
      web.root.returns(rootSpan)

      fsOperationStart.publish(ctx)

      sinon.assert.calledOnceWithExactly(blocking.block, req, res, rootSpan, null, blockingAction.block_request)
    })

    it('should not block req if there is no block_request action', () => {
      const fs = { root: true }
      datadogCore.storage.getStore.returns({ req, res, fs })

      const blockingAction = {}
      waf.run.returns(blockingAction)

      const rootSpan = {
        context: () => {
          return { _name: 'express.request' }
        }
      }
      web.root.returns(rootSpan)

      fsOperationStart.publish(ctx)

      sinon.assert.notCalled(blocking.block)
    })
  })

  describe('handleUncaughtExceptionMonitor', () => {
    it('should not break with infinite loop of cause', () => {
      const err = new Error()
      err.cause = err

      handleUncaughtExceptionMonitor(err)
    })
  })
})
