'use strict'

const proxyquire = require('proxyquire')
const { httpClientRequestStart } = require('../../src/appsec/channels')
const addresses = require('../../src/appsec/addresses')

describe('RASP', () => {
  let waf, rasp, datadogCore, stackTrace, web

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

    rasp = proxyquire('../../src/appsec/rasp', {
      '../../../datadog-core': datadogCore,
      './waf': waf,
      './stack_trace': stackTrace,
      './../plugins/util/web': web
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
})
