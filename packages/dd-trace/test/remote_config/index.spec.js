'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')
const getConfig = require('../../src/config')
const RemoteConfigCapabilities = require('../../src/remote_config/capabilities')

let config
let rc
let RemoteConfigManager
let remoteConfig

describe('Remote Config index', () => {
  beforeEach(() => {
    config = getConfig({
      appsec: {
        enabled: undefined,
        eventTracking: {
          mode: 'identification'
        }
      }
    })

    rc = {
      updateCapabilities: sinon.spy(),
      setBatchHandler: sinon.spy(),
      removeBatchHandler: sinon.spy(),
      setProductHandler: sinon.spy(),
      removeProductHandler: sinon.spy(),
      subscribeProducts: sinon.spy(),
      unsubscribeProducts: sinon.spy()
    }

    RemoteConfigManager = sinon.stub().returns(rc)

    remoteConfig = proxyquire('../../src/remote_config', {
      './manager': RemoteConfigManager
    })
  })

  describe('enable', () => {
    it('should initialize remote config manager', () => {
      const result = remoteConfig.enable(config)

      sinon.assert.calledOnceWithExactly(RemoteConfigManager, config)
      assert.strictEqual(result, rc)
    })

    it('should enable APM tracing capabilities', () => {
      remoteConfig.enable(config)

      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_CUSTOM_TAGS, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_HTTP_HEADER_TAGS, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_LOGS_INJECTION, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_SAMPLE_RATE, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_ENABLED, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_SAMPLE_RULES, true)
    })

    it('should enable FFE_FLAG_CONFIGURATION_RULES capability', () => {
      remoteConfig.enable(config)

      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.FFE_FLAG_CONFIGURATION_RULES, true)
    })

    it('should not configure appsec handlers', () => {
      remoteConfig.enable(config)

      sinon.assert.neverCalledWith(rc.updateCapabilities, RemoteConfigCapabilities.ASM_ACTIVATION)
      sinon.assert.neverCalledWith(rc.updateCapabilities, RemoteConfigCapabilities.ASM_AUTO_USER_INSTRUM_MODE)
      sinon.assert.notCalled(rc.setProductHandler)
    })
  })
})
