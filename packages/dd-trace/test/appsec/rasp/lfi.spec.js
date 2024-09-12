'use strict'

const proxyquire = require('proxyquire')
const { fsOperationStart } = require('../../../src/appsec/channels')
const { FS_OPERATION_PATH } = require('../../../src/appsec/addresses')
const { DatadogRaspAbortError } = require('../../../src/appsec/rasp/utils')

describe('RASP - lfi.js', () => {
  let waf, datadogCore, lfi, web, blocking, utils, appsecFsPlugin

  beforeEach(() => {
    datadogCore = {
      storage: {
        getStore: sinon.stub()
      }
    }

    waf = {
      run: sinon.stub()
    }

    web = {
      root: sinon.stub()
    }

    blocking = {
      block: sinon.stub()
    }

    appsecFsPlugin = {
      enable: sinon.stub(),
      disable: sinon.stub()
    }

    utils = {
      handleResult: sinon.stub()
    }

    lfi = proxyquire('../../../src/appsec/rasp/lfi', {
      '../../../../datadog-core': datadogCore,
      '../waf': waf,
      '../../plugins/util/web': web,
      '../blocking': blocking,
      './utils': utils,
      './fs-plugin': appsecFsPlugin
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

    lfi.enable(config)
  })

  afterEach(() => {
    sinon.restore()
    lfi.disable()
  })

  describe('enable', () => {
    it('should enable AppsecFsPlugin', () => {
      sinon.assert.calledOnceWithExactly(appsecFsPlugin.enable, 'rasp')
    })
  })

  describe('disable', () => {
    it('should disable AppsecFsPlugin', () => {
      lfi.disable()
      sinon.assert.calledOnceWithExactly(appsecFsPlugin.disable, 'rasp')
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

      const persistent = { [FS_OPERATION_PATH]: path }
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

      utils.handleResult.callsFake((actions, req, res, abortController, config) => {
        const abortError = new DatadogRaspAbortError(req, res, blockingAction.block_request)
        abortController.abort(abortError)
      })

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
})
