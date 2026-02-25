'use strict'

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

const RemoteConfigCapabilities = require('../../src/remote_config/capabilities')
const { enable } = require('../../src/openfeature/remote_config')

require('../setup/mocha')

describe('OpenFeature Remote Config', () => {
  let rc
  let config
  let openfeatureProxy
  let getOpenfeatureProxy
  let handlers

  beforeEach(() => {
    handlers = new Map()

    rc = {
      updateCapabilities: sinon.spy(),
      setProductHandler: sinon.spy((product, handler) => {
        handlers.set(product, handler)
      }),
    }

    config = {
      experimental: {
        flaggingProvider: {
          enabled: true,
        },
      },
    }

    openfeatureProxy = {
      _setConfiguration: sinon.spy(),
    }

    getOpenfeatureProxy = sinon.stub().returns(openfeatureProxy)
  })

  describe('enable', () => {
    it('should enable FFE_FLAG_CONFIGURATION_RULES capability', () => {
      enable(rc, config, getOpenfeatureProxy)

      sinon.assert.calledOnceWithExactly(
        rc.updateCapabilities,
        RemoteConfigCapabilities.FFE_FLAG_CONFIGURATION_RULES,
        true
      )
    })

    it('should register FFE_FLAGS product handler', () => {
      enable(rc, config, getOpenfeatureProxy)

      sinon.assert.calledOnceWithExactly(rc.setProductHandler, 'FFE_FLAGS', sinon.match.func)
    })

    it('should call _setConfiguration on apply action when feature is enabled', () => {
      enable(rc, config, getOpenfeatureProxy)

      const flagConfig = { flags: { 'test-flag': {} } }
      const handler = handlers.get('FFE_FLAGS')

      handler('apply', flagConfig)

      sinon.assert.calledOnceWithExactly(openfeatureProxy._setConfiguration, flagConfig)
    })

    it('should call _setConfiguration on modify action when feature is enabled', () => {
      enable(rc, config, getOpenfeatureProxy)

      const flagConfig = { flags: { 'modified-flag': {} } }
      const handler = handlers.get('FFE_FLAGS')

      handler('modify', flagConfig)

      sinon.assert.calledOnceWithExactly(openfeatureProxy._setConfiguration, flagConfig)
    })

    it('should not call _setConfiguration on unapply action', () => {
      enable(rc, config, getOpenfeatureProxy)

      const flagConfig = { flags: { 'test-flag': {} } }
      const handler = handlers.get('FFE_FLAGS')

      handler('unapply', flagConfig)

      sinon.assert.notCalled(openfeatureProxy._setConfiguration)
    })

    it('should not call _setConfiguration on unknown action', () => {
      enable(rc, config, getOpenfeatureProxy)

      const flagConfig = { flags: { 'test-flag': {} } }
      const handler = handlers.get('FFE_FLAGS')

      handler('unknown', flagConfig)

      sinon.assert.notCalled(openfeatureProxy._setConfiguration)
    })

    it('should not register product handler when experimental feature is disabled', () => {
      config.experimental.flaggingProvider.enabled = false
      enable(rc, config, getOpenfeatureProxy)

      sinon.assert.notCalled(rc.setProductHandler)
    })

    it('should still enable capability even when experimental feature is disabled', () => {
      config.experimental.flaggingProvider.enabled = false
      enable(rc, config, getOpenfeatureProxy)

      sinon.assert.calledOnceWithExactly(
        rc.updateCapabilities,
        RemoteConfigCapabilities.FFE_FLAG_CONFIGURATION_RULES,
        true
      )
    })
  })
})
