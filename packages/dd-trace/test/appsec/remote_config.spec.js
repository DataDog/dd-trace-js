'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const getConfig = require('../../src/config')
const RuleManager = require('../../src/appsec/rule_manager')
const RemoteConfigCapabilities = require('../../src/remote_config/capabilities')
const { assertObjectContains } = require('../../../../integration-tests/helpers')

require('../setup/core')

let config
let rc
let UserTracking
let log
let telemetry
let appsec
let appsecRemoteConfig

describe('AppSec Remote Config', () => {
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

    UserTracking = {
      setCollectionMode: sinon.stub()
    }

    log = {
      error: sinon.stub()
    }

    telemetry = {
      updateConfig: sinon.stub()
    }

    appsec = {
      enable: sinon.spy(),
      disable: sinon.spy()
    }

    appsecRemoteConfig = proxyquire('../../src/appsec/remote_config', {
      './user_tracking': UserTracking,
      '../log': log,
      '../telemetry': telemetry
    })
  })

  describe('enable', () => {
    it('should listen to remote config when appsec is not explicitly configured', () => {
      config.appsec.enabled = undefined

      appsecRemoteConfig.enable(rc, config, appsec)

      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.ASM_ACTIVATION, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.ASM_AUTO_USER_INSTRUM_MODE, true)
      sinon.assert.calledWith(rc.setProductHandler, 'ASM_FEATURES')
      assert.strictEqual(typeof rc.setProductHandler.firstCall.args[1], 'function')
    })

    it('should listen to remote config when appsec is explicitly configured as enabled=true', () => {
      config.appsec.enabled = true

      appsecRemoteConfig.enable(rc, config, appsec)

      sinon.assert.neverCalledWith(rc.updateCapabilities, RemoteConfigCapabilities.ASM_ACTIVATION)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.ASM_AUTO_USER_INSTRUM_MODE, true)
      sinon.assert.calledOnceWithMatch(rc.setProductHandler, 'ASM_FEATURES')
      assert.strictEqual(typeof rc.setProductHandler.firstCall.args[1], 'function')
    })

    it('should not listen to remote config when appsec is explicitly configured as enabled=false', () => {
      config.appsec.enabled = false

      appsecRemoteConfig.enable(rc, config, appsec)

      sinon.assert.neverCalledWith(rc.updateCapabilities, RemoteConfigCapabilities.ASM_ACTIVATION, true)
      sinon.assert.neverCalledWith(rc.updateCapabilities, RemoteConfigCapabilities.ASM_AUTO_USER_INSTRUM_MODE, true)
      sinon.assert.notCalled(rc.setProductHandler)
    })

    describe('ASM_FEATURES remote config listener', () => {
      let listener

      beforeEach(() => {
        config.appsec.enabled = undefined
        appsecRemoteConfig.enable(rc, config, appsec)

        listener = rc.setProductHandler.firstCall.args[1]
      })

      it('should do nothing when listener is called with falsy rcConfig', () => {
        listener('apply', null)

        sinon.assert.notCalled(appsec.enable)
        sinon.assert.notCalled(appsec.disable)
        sinon.assert.notCalled(UserTracking.setCollectionMode)
      })

      it('should not call enableOrDisableAppsec when activation is not ONECLICK', () => {
        // When config.appsec.enabled is true, activation is not ONECLICK
        config.appsec.enabled = true
        appsecRemoteConfig.enable(rc, config, appsec)

        const listener2 = rc.setProductHandler.secondCall.args[1]
        appsec.enable.resetHistory()
        appsec.disable.resetHistory()

        listener2('apply', { asm: { enabled: true } })

        // Should not call enable/disable because activation is not ONECLICK
        sinon.assert.notCalled(appsec.enable)
        sinon.assert.notCalled(appsec.disable)
      })

      it('should enable appsec when listener is called with apply and enabled', () => {
        listener('apply', { asm: { enabled: true } })

        sinon.assert.called(appsec.enable)
      })

      it('should enable appsec when listener is called with modify and enabled', () => {
        listener('modify', { asm: { enabled: true } })

        sinon.assert.called(appsec.enable)
      })

      it('should disable appsec when listener is called with unapply and enabled', () => {
        listener('unapply', { asm: { enabled: true } })

        sinon.assert.calledOnce(appsec.disable)
      })

      it('should not do anything when listener is called with apply and malformed data', () => {
        listener('apply', {})

        sinon.assert.notCalled(appsec.enable)
        sinon.assert.notCalled(appsec.disable)
      })

      describe('update config origin activation', () => {
        const rcConfigAsmEnabling = { asm: { enabled: true } }
        const rcConfigAsmDisabling = { asm: { enabled: true } }

        it('should update appsec.enabled when applying asm enabling by RC', () => {
          listener('apply', rcConfigAsmEnabling)

          sinon.assert.calledOnce(telemetry.updateConfig)
          assertObjectContains(telemetry.updateConfig.firstCall.args, [[{
            name: 'appsec.enabled',
            origin: 'remote_config',
            value: rcConfigAsmEnabling.asm.enabled
          }]])
        })

        it('should update appsec.enabled when modifying asm enabling by RC', () => {
          listener('modify', rcConfigAsmDisabling)

          sinon.assert.calledOnce(telemetry.updateConfig)
          assertObjectContains(telemetry.updateConfig.firstCall.args, [[{
            name: 'appsec.enabled',
            origin: 'remote_config',
            value: rcConfigAsmDisabling.asm.enabled
          }]])
        })

        it('should update when unapplying asm enabling by RC', () => {
          listener('unapply', { asm: { enabled: true } })

          sinon.assert.calledOnce(telemetry.updateConfig)
          assertObjectContains(telemetry.updateConfig.firstCall.args, [[{
            name: 'appsec.enabled',
            origin: 'default',
            value: config.appsec.enabled
          }]])
        })
      })

      describe('auto_user_instrum', () => {
        const rcConfig = { auto_user_instrum: { mode: 'anonymous' } }
        const configId = 'collectionModeId'

        afterEach(() => {
          listener('unapply', rcConfig, configId)
        })

        it('should not update collection mode when not a string', () => {
          listener('apply', { auto_user_instrum: { mode: 123 } }, configId)

          sinon.assert.notCalled(UserTracking.setCollectionMode)
        })

        it('should throw when called two times with different config ids', () => {
          listener('apply', rcConfig, configId)

          assert.throws(() => listener('apply', rcConfig, 'anotherId'))
          sinon.assert.calledOnceWithExactly(log.error,
            '[RC] Multiple auto_user_instrum received in ASM_FEATURES. Discarding config'
          )
        })

        it('should update collection mode when called with apply', () => {
          listener('apply', rcConfig, configId)

          sinon.assert.calledOnceWithExactly(UserTracking.setCollectionMode, rcConfig.auto_user_instrum.mode)
        })

        it('should update collection mode when called with modify', () => {
          listener('modify', rcConfig, configId)

          sinon.assert.calledOnceWithExactly(UserTracking.setCollectionMode, rcConfig.auto_user_instrum.mode)
        })

        it('should revert collection mode when called with unapply', () => {
          listener('apply', rcConfig, configId)
          UserTracking.setCollectionMode.resetHistory()

          listener('unapply', rcConfig, configId)

          sinon.assert.calledOnceWithExactly(UserTracking.setCollectionMode, config.appsec.eventTracking.mode)
        })

        it('should not revert collection mode when called with unapply and unknown id', () => {
          listener('apply', rcConfig, configId)
          UserTracking.setCollectionMode.resetHistory()

          listener('unapply', rcConfig, 'unknownId')

          sinon.assert.notCalled(UserTracking.setCollectionMode)
        })
      })
    })
  })

  describe('enableWafUpdate', () => {
    const expectCapabilitiesCalledWith = (capabilityList, expectedValue) => {
      capabilityList.forEach(capability => {
        sinon.assert.calledWithExactly(rc.updateCapabilities, capability, expectedValue)
      })
    }

    const expectCapabilitiesNotCalled = (capabilityList) => {
      capabilityList.forEach(capability => {
        sinon.assert.neverCalledWith(rc.updateCapabilities, capability)
      })
    }

    const CORE_ASM_CAPABILITIES = [
      RemoteConfigCapabilities.ASM_IP_BLOCKING,
      RemoteConfigCapabilities.ASM_USER_BLOCKING,
      RemoteConfigCapabilities.ASM_DD_RULES,
      RemoteConfigCapabilities.ASM_EXCLUSIONS,
      RemoteConfigCapabilities.ASM_REQUEST_BLOCKING,
      RemoteConfigCapabilities.ASM_RESPONSE_BLOCKING,
      RemoteConfigCapabilities.ASM_CUSTOM_RULES,
      RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE,
      RemoteConfigCapabilities.ASM_TRUSTED_IPS,
      RemoteConfigCapabilities.ASM_PROCESSOR_OVERRIDES,
      RemoteConfigCapabilities.ASM_CUSTOM_DATA_SCANNERS,
      RemoteConfigCapabilities.ASM_EXCLUSION_DATA,
      RemoteConfigCapabilities.ASM_ENDPOINT_FINGERPRINT,
      RemoteConfigCapabilities.ASM_SESSION_FINGERPRINT,
      RemoteConfigCapabilities.ASM_NETWORK_FINGERPRINT,
      RemoteConfigCapabilities.ASM_HEADER_FINGERPRINT,
      RemoteConfigCapabilities.ASM_DD_MULTICONFIG,
      RemoteConfigCapabilities.ASM_TRACE_TAGGING_RULES
    ]

    const RASP_CAPABILITIES = [
      RemoteConfigCapabilities.ASM_RASP_SSRF,
      RemoteConfigCapabilities.ASM_RASP_SQLI,
      RemoteConfigCapabilities.ASM_RASP_LFI,
      RemoteConfigCapabilities.ASM_RASP_SHI,
      RemoteConfigCapabilities.ASM_RASP_CMDI
    ]

    const ALL_ASM_CAPABILITIES = [...CORE_ASM_CAPABILITIES, ...RASP_CAPABILITIES]

    describe('enable', () => {
      it('should not fail if remote config is not configured before', () => {
        config.appsec = {}
        appsecRemoteConfig.enableWafUpdate(config.appsec)

        sinon.assert.notCalled(rc.updateCapabilities)
        sinon.assert.notCalled(rc.setProductHandler)
      })

      it('should not enable when custom appsec rules are provided', () => {
        config.appsec = { enabled: true, rules: {} }
        appsecRemoteConfig.enable(rc, config, appsec)
        appsecRemoteConfig.enableWafUpdate(config.appsec)

        sinon.assert.neverCalledWith(rc.updateCapabilities, 'ASM_ACTIVATION')
        sinon.assert.called(rc.setProductHandler)
      })

      it('should enable when using default rules', () => {
        config.appsec = { enabled: true, rules: null, rasp: { enabled: true } }
        appsecRemoteConfig.enable(rc, config, appsec)
        appsecRemoteConfig.enableWafUpdate(config.appsec)

        expectCapabilitiesCalledWith(ALL_ASM_CAPABILITIES, true)

        sinon.assert.calledWith(rc.subscribeProducts, 'ASM', 'ASM_DD', 'ASM_DATA')
        sinon.assert.calledWithExactly(rc.setBatchHandler, ['ASM', 'ASM_DD', 'ASM_DATA'], RuleManager.updateWafFromRC)
      })

      it('should activate if appsec is manually enabled', () => {
        config.appsec = { enabled: true, rasp: { enabled: true } }
        appsecRemoteConfig.enable(rc, config, appsec)
        appsecRemoteConfig.enableWafUpdate(config.appsec)

        expectCapabilitiesCalledWith(ALL_ASM_CAPABILITIES, true)

        sinon.assert.calledWith(rc.subscribeProducts, 'ASM', 'ASM_DD', 'ASM_DATA')
        sinon.assert.calledWithExactly(rc.setBatchHandler, ['ASM', 'ASM_DD', 'ASM_DATA'], RuleManager.updateWafFromRC)
      })

      it('should activate if appsec enabled is not defined', () => {
        config.appsec = { rasp: { enabled: true } }
        appsecRemoteConfig.enable(rc, config, appsec)
        appsecRemoteConfig.enableWafUpdate(config.appsec)

        expectCapabilitiesCalledWith(ALL_ASM_CAPABILITIES, true)
      })

      it('should not activate rasp capabilities if rasp is disabled', () => {
        config.appsec = { rasp: { enabled: false } }
        appsecRemoteConfig.enable(rc, config, appsec)
        appsecRemoteConfig.enableWafUpdate(config.appsec)

        expectCapabilitiesCalledWith(CORE_ASM_CAPABILITIES, true)
        expectCapabilitiesNotCalled(RASP_CAPABILITIES)
      })
    })

    describe('disable', () => {
      it('should update capabilities and unsubscribe listener', () => {
        appsecRemoteConfig.enable(rc, config, appsec)
        rc.updateCapabilities.resetHistory()
        appsecRemoteConfig.disableWafUpdate()

        expectCapabilitiesCalledWith(ALL_ASM_CAPABILITIES, false)

        sinon.assert.calledWith(rc.unsubscribeProducts, 'ASM', 'ASM_DD', 'ASM_DATA')
        sinon.assert.calledWithExactly(rc.removeBatchHandler, RuleManager.updateWafFromRC)
      })

      it('should not fail when called without rc being configured', () => {
        // Call disableWafUpdate without calling enable first
        appsecRemoteConfig.disableWafUpdate()

        sinon.assert.notCalled(rc.updateCapabilities)
        sinon.assert.notCalled(rc.unsubscribeProducts)
      })
    })
  })
})
