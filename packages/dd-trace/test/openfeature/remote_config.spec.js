'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const RemoteConfigCapabilities = require('../../src/remote_config/capabilities')

require('../setup/mocha')

describe('OpenFeature Remote Config', () => {
  let rc
  let openfeatureProxy
  let getOpenfeatureProxy
  let handlers
  let log
  let enable

  beforeEach(() => {
    log = {
      debug: sinon.spy((messageOrFn) => {
        // Simulates a debug-enabled logger, which invokes the lazy callback form.
        if (typeof messageOrFn === 'function') messageOrFn()
      }),
    }

    ;({ enable } = proxyquire('../../src/openfeature/remote_config', {
      '../log': log,
    }))

    handlers = new Map()

    rc = {
      updateCapabilities: sinon.spy(),
      setProductHandler: sinon.spy((product, handler) => {
        handlers.set(product, handler)
      }),
    }

    openfeatureProxy = {
      setConfiguration: sinon.spy(),
    }

    getOpenfeatureProxy = sinon.stub().returns(openfeatureProxy)
  })

  describe('enable', () => {
    it('should enable FFE_FLAG_CONFIGURATION_RULES capability', () => {
      enable(rc, getOpenfeatureProxy, true)

      sinon.assert.calledOnceWithExactly(
        rc.updateCapabilities,
        RemoteConfigCapabilities.FFE_FLAG_CONFIGURATION_RULES,
        true
      )
    })

    it('should register FFE_FLAGS product handler', () => {
      enable(rc, getOpenfeatureProxy, true)

      sinon.assert.calledOnceWithExactly(rc.setProductHandler, 'FFE_FLAGS', sinon.match.func)
    })

    it('logs starting the remote_config source when enabled', () => {
      enable(rc, getOpenfeatureProxy, true)

      sinon.assert.calledWith(
        log.debug,
        'Feature Flags: starting remote_config configuration source (Agent Remote Configuration)'
      )
    })

    it('should call setConfiguration on apply action when feature is enabled', () => {
      enable(rc, getOpenfeatureProxy, true)

      const flagConfig = { flags: { 'test-flag': {}, 'another-flag': {} } }
      const handler = handlers.get('FFE_FLAGS')

      handler('apply', flagConfig)

      sinon.assert.calledOnceWithExactly(openfeatureProxy.setConfiguration, flagConfig)
      const debugCall = log.debug.getCalls().find((call) => typeof call.args[0] === 'function')
      assert.strictEqual(
        debugCall.args[0](),
        'Feature Flags: remote_config configuration apply applied successfully (2 flag(s))'
      )
    })

    it('should call setConfiguration on modify action when feature is enabled', () => {
      enable(rc, getOpenfeatureProxy, true)

      const flagConfig = { flags: { 'modified-flag': {} } }
      const handler = handlers.get('FFE_FLAGS')

      handler('modify', flagConfig)

      sinon.assert.calledOnceWithExactly(openfeatureProxy.setConfiguration, flagConfig)
    })

    it('should call setConfiguration(undefined) on unapply action to clear config', () => {
      enable(rc, getOpenfeatureProxy, true)

      const flagConfig = { flags: { 'test-flag': {} } }
      const handler = handlers.get('FFE_FLAGS')

      handler('unapply', flagConfig)

      sinon.assert.calledOnceWithExactly(openfeatureProxy.setConfiguration, undefined)
      sinon.assert.calledWith(log.debug, 'Feature Flags: remote_config configuration removed')
    })

    it('should not call setConfiguration on unknown action', () => {
      enable(rc, getOpenfeatureProxy, true)

      const flagConfig = { flags: { 'test-flag': {} } }
      const handler = handlers.get('FFE_FLAGS')

      handler('unknown', flagConfig)

      sinon.assert.notCalled(openfeatureProxy.setConfiguration)
    })

    it('should not advertise capability or register a handler without Remote Config delivery', () => {
      enable(rc, getOpenfeatureProxy, false)

      sinon.assert.notCalled(rc.updateCapabilities)
      sinon.assert.notCalled(rc.setProductHandler)
    })
  })
})
