'use strict'

const proxyquire = require('proxyquire')
const { assert } = require('chai')
const { fsOperationStart, incomingHttpRequestStart } = require('../../../src/appsec/channels')
const { FS_OPERATION_PATH } = require('../../../src/appsec/addresses')
const { RASP_MODULE } = require('../../../src/appsec/rasp/fs-plugin')

describe('RASP - lfi.js', () => {
  let waf, legacyStorage, lfi, web, blocking, appsecFsPlugin, config

  beforeEach(() => {
    legacyStorage = {
      getStore: sinon.stub()
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

    lfi = proxyquire('../../../src/appsec/rasp/lfi', {
      '../../../../datadog-core': { storage: () => legacyStorage },
      '../waf': waf,
      '../../../../datadog-plugin-web/src/utils': web,
      '../blocking': blocking,
      './fs-plugin': appsecFsPlugin
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

  afterEach(() => {
    sinon.restore()
    lfi.disable()
  })

  describe('enable', () => {
    it('should subscribe to first http req', () => {
      const subscribe = sinon.stub(incomingHttpRequestStart, 'subscribe')

      lfi.enable(config)

      sinon.assert.calledOnce(subscribe)
    })

    it('should enable AppsecFsPlugin after the first request', () => {
      const unsubscribe = sinon.stub(incomingHttpRequestStart, 'unsubscribe')
      const fsOpSubscribe = sinon.stub(fsOperationStart, 'subscribe')

      lfi.enable(config)

      incomingHttpRequestStart.publish({})

      sinon.assert.calledOnceWithExactly(appsecFsPlugin.enable, RASP_MODULE)

      assert(fsOpSubscribe.calledAfter(appsecFsPlugin.enable))

      process.nextTick(() => {
        sinon.assert.calledOnce(unsubscribe)
      })
    })
  })

  describe('disable', () => {
    it('should disable AppsecFsPlugin', () => {
      lfi.enable(config)

      lfi.disable()
      sinon.assert.calledOnceWithExactly(appsecFsPlugin.disable, RASP_MODULE)
    })
  })

  describe('analyzeLfi', () => {
    const path = '/etc/passwd'
    const ctx = { path }
    const req = {}

    beforeEach(() => {
      lfi.enable(config)

      incomingHttpRequestStart.publish({})
    })

    it('should analyze lfi for root fs operations', () => {
      const fs = { root: true }
      legacyStorage.getStore.returns({ req, fs })

      fsOperationStart.publish(ctx)

      const ephemeral = { [FS_OPERATION_PATH]: path }
      sinon.assert.calledOnceWithExactly(waf.run, { ephemeral }, req, { type: 'lfi' })
    })

    it('should NOT analyze lfi for child fs operations', () => {
      const fs = {}
      legacyStorage.getStore.returns({ req, fs })

      fsOperationStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should NOT analyze lfi for undefined fs (AppsecFsPlugin disabled)', () => {
      const fs = undefined
      legacyStorage.getStore.returns({ req, fs })

      fsOperationStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })

    it('should NOT analyze lfi for excluded operations', () => {
      const fs = { opExcluded: true, root: true }
      legacyStorage.getStore.returns({ req, fs })

      fsOperationStart.publish(ctx)

      sinon.assert.notCalled(waf.run)
    })
  })
})
