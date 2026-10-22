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
        'Feature Flags: remote_config configuration apply applied successfully (2 flag(s) received; ' +
      'per-flag validity is checked at evaluation, ' +
        'configuration environment=undefined, createdAt=undefined, id=undefined)'
      )
    })

    it('logs the delivered configuration identity on apply', () => {
      enable(rc, getOpenfeatureProxy, true)

      const flagConfig = {
        createdAt: '2026-01-01T00:00:00.000Z',
        environment: { name: 'Production' },
        flags: { 'test-flag': {} },
      }
      const handler = handlers.get('FFE_FLAGS')
      handler('apply', flagConfig, 'config-id')

      const debugCall = log.debug.getCalls().find((call) => typeof call.args[0] === 'function')
      assert.strictEqual(
        debugCall.args[0](),
        'Feature Flags: remote_config configuration apply applied successfully (1 flag(s) received; ' +
      'per-flag validity is checked at evaluation, ' +
        'configuration environment=Production, createdAt=2026-01-01T00:00:00.000Z, id=config-id)'
      )
    })

    it('logs and rethrows a configuration that could not be applied', () => {
      log.warn = sinon.spy()
      const error = new Error('listener failed')
      openfeatureProxy.setConfiguration = sinon.stub().throws(error)
      enable(rc, getOpenfeatureProxy, true)

      const handler = handlers.get('FFE_FLAGS')
      assert.throws(() => handler('modify', { flags: {} }, 'config-id'), error)

      sinon.assert.calledOnceWithExactly(log.warn,
        'Feature Flags: remote_config configuration %s could not be applied: %s', 'config-id', 'listener failed')
      assert.ok(log.debug.getCalls().every((call) => typeof call.args[0] !== 'function'))
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

      handler('unapply', flagConfig, 'config-id')

      sinon.assert.calledOnceWithExactly(openfeatureProxy.setConfiguration, undefined)
      sinon.assert.calledWith(log.debug,
        'Feature Flags: remote_config configuration %s removed; flag evaluations will return their default values',
        'config-id')
    })

    it('applies, modifies, and removes configuration when diagnostic formatting fails', async () => {
      const realLog = require('../../src/log')
      const writer = require('../../src/log/writer')
      const Provider = proxyquire('../../src/openfeature/flagging_provider', { '../log': realLog })
      const messages = []
      const capture = message => { messages.push(String(message)) }
      writer.configure(true, 'debug', { debug: capture, warn: capture, error: capture })
      const provider = new Provider({}, {
        debug: true,
        featureFlags: {
          DD_FLAGGING_EVALUATION_COUNTS_ENABLED: false,
          DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: 1000,
        },
      })
      try {
        const realEnable = proxyquire('../../src/openfeature/remote_config', { '../log': realLog }).enable
        realEnable(rc, () => provider, true)
        const handler = handlers.get('FFE_FLAGS')
        const configuration = { flags: {}, createdAt: 'fixture', environment: { name: 'test' } }
        const initialized = provider.initialize()
        handler('apply', configuration, 'id')
        await initialized
        assert.strictEqual(provider.getConfiguration(), configuration)

        const replacement = { createdAt: 'replacement', environment: { name: 'test' } }
        Object.defineProperty(replacement, 'flags', { get () { throw new Error('formatter failure') } })
        handler('modify', replacement, 'id')
        assert.strictEqual(provider.getConfiguration(), replacement)
        assert.ok(messages.includes('Feature Flags: configuration applied; diagnostic details unavailable'))

        handler('unapply', undefined, 'id')
        assert.strictEqual(provider.getConfiguration(), undefined)
      } finally {
        provider.onClose()
        realLog.configure({})
      }
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
