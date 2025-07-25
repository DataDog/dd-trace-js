'use strict'

require('../setup/tap')

const RuleManager = require('../../src/appsec/rule_manager')
const RemoteConfigCapabilities = require('../../src/remote_config/capabilities')
const { kPreUpdate } = require('../../src/remote_config/manager')

let config
let rc
let RemoteConfigManager
let UserTracking
let log
let appsec
let remoteConfig

describe('Remote Config index', () => {
  beforeEach(() => {
    config = {
      appsec: {
        enabled: undefined,
        eventTracking: {
          mode: 'identification'
        }
      }
    }

    rc = {
      updateCapabilities: sinon.spy(),
      on: sinon.spy(),
      off: sinon.spy(),
      setProductHandler: sinon.spy(),
      removeProductHandler: sinon.spy()
    }

    RemoteConfigManager = sinon.stub().returns(rc)

    UserTracking = {
      setCollectionMode: sinon.stub()
    }

    log = {
      error: sinon.stub()
    }

    appsec = {
      enable: sinon.spy(),
      disable: sinon.spy()
    }

    remoteConfig = proxyquire('../src/remote_config', {
      './manager': RemoteConfigManager,
      '../appsec/user_tracking': UserTracking,
      '../log': log,
    })
  })

  describe('enable', () => {
    it('should listen to remote config when appsec is not explicitly configured', () => {
      config.appsec.enabled = undefined

      remoteConfig.enable(config)

      expect(RemoteConfigManager).to.have.been.calledOnceWithExactly(config)
      expect(rc.updateCapabilities).to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_ACTIVATION, true)
      expect(rc.updateCapabilities)
        .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_AUTO_USER_INSTRUM_MODE, true)
      expect(rc.setProductHandler).to.have.been.calledWith('ASM_FEATURES')
      expect(rc.setProductHandler.firstCall.args[1]).to.be.a('function')
    })

    it('should listen to remote config when appsec is explicitly configured as enabled=true', () => {
      config.appsec.enabled = true

      remoteConfig.enable(config)

      expect(RemoteConfigManager).to.have.been.calledOnceWithExactly(config)
      expect(rc.updateCapabilities).to.not.have.been.calledWith(RemoteConfigCapabilities.ASM_ACTIVATION)
      expect(rc.updateCapabilities)
        .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_AUTO_USER_INSTRUM_MODE, true)
      expect(rc.setProductHandler).to.have.been.calledOnceWith('ASM_FEATURES')
      expect(rc.setProductHandler.firstCall.args[1]).to.be.a('function')
    })

    it('should not listen to remote config when appsec is explicitly configured as enabled=false', () => {
      config.appsec.enabled = false

      remoteConfig.enable(config)

      expect(RemoteConfigManager).to.have.been.calledOnceWithExactly(config)
      expect(rc.updateCapabilities).to.not.have.been.calledWith(RemoteConfigCapabilities.ASM_ACTIVATION, true)
      expect(rc.updateCapabilities)
        .to.not.have.been.calledWith(RemoteConfigCapabilities.ASM_AUTO_USER_INSTRUM_MODE, true)
      expect(rc.setProductHandler).to.not.have.been.called
    })

    describe('ASM_FEATURES remote config listener', () => {
      let listener

      beforeEach(() => {
        remoteConfig.enable(config, appsec)

        listener = rc.setProductHandler.firstCall.args[1]
      })

      it('should enable appsec when listener is called with apply and enabled', () => {
        listener('apply', { asm: { enabled: true } })

        expect(appsec.enable).to.have.been.called
      })

      it('should enable appsec when listener is called with modify and enabled', () => {
        listener('modify', { asm: { enabled: true } })

        expect(appsec.enable).to.have.been.called
      })

      it('should disable appsec when listener is called with unapply and enabled', () => {
        listener('unapply', { asm: { enabled: true } })

        expect(appsec.disable).to.have.been.calledOnce
      })

      it('should not do anything when listener is called with apply and malformed data', () => {
        listener('apply', {})

        expect(appsec.enable).to.not.have.been.called
        expect(appsec.disable).to.not.have.been.called
      })

      describe('auto_user_instrum', () => {
        const rcConfig = { auto_user_instrum: { mode: 'anonymous' } }
        const configId = 'collectionModeId'

        afterEach(() => {
          listener('unapply', rcConfig, configId)
        })

        it('should not update collection mode when not a string', () => {
          listener('apply', { auto_user_instrum: { mode: 123 } }, configId)

          expect(UserTracking.setCollectionMode).to.not.have.been.called
        })

        it('should throw when called two times with different config ids', () => {
          listener('apply', rcConfig, configId)

          expect(() => listener('apply', rcConfig, 'anotherId')).to.throw()
          expect(log.error).to.have.been.calledOnceWithExactly(
            '[RC] Multiple auto_user_instrum received in ASM_FEATURES. Discarding config'
          )
        })

        it('should update collection mode when called with apply', () => {
          listener('apply', rcConfig, configId)

          expect(UserTracking.setCollectionMode).to.have.been.calledOnceWithExactly(rcConfig.auto_user_instrum.mode)
        })

        it('should update collection mode when called with modify', () => {
          listener('modify', rcConfig, configId)

          expect(UserTracking.setCollectionMode).to.have.been.calledOnceWithExactly(rcConfig.auto_user_instrum.mode)
        })

        it('should revert collection mode when called with unapply', () => {
          listener('apply', rcConfig, configId)
          UserTracking.setCollectionMode.resetHistory()

          listener('unapply', rcConfig, configId)

          expect(UserTracking.setCollectionMode).to.have.been.calledOnceWithExactly(config.appsec.eventTracking.mode)
        })

        it('should not revert collection mode when called with unapply and unknown id', () => {
          listener('apply', rcConfig, configId)
          UserTracking.setCollectionMode.resetHistory()

          listener('unapply', rcConfig, 'unknownId')

          expect(UserTracking.setCollectionMode).to.not.have.been.called
        })
      })
    })
  })

  describe('enableWafUpdate', () => {
    const expectCapabilitiesCalledWith = (capabilityList, expectedValue) => {
      capabilityList.forEach(capability => {
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(capability, expectedValue)
      })
    }

    const expectCapabilitiesNotCalled = (capabilityList) => {
      capabilityList.forEach(capability => {
        expect(rc.updateCapabilities)
          .to.not.have.been.calledWith(capability)
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
      it('should not fail if remote config is not enabled before', () => {
        config.appsec = {}
        remoteConfig.enableWafUpdate(config.appsec)

        expect(rc.updateCapabilities).to.not.have.been.called
        expect(rc.setProductHandler).to.not.have.been.called
      })

      it('should not enable when custom appsec rules are provided', () => {
        config.appsec = { enabled: true, rules: {} }
        remoteConfig.enable(config)
        remoteConfig.enableWafUpdate(config.appsec)

        expect(rc.updateCapabilities).to.not.have.been.calledWith('ASM_ACTIVATION')
        expect(rc.setProductHandler).to.have.been.called
      })

      it('should enable when using default rules', () => {
        config.appsec = { enabled: true, rules: null, rasp: { enabled: true } }
        remoteConfig.enable(config)
        remoteConfig.enableWafUpdate(config.appsec)

        expectCapabilitiesCalledWith(ALL_ASM_CAPABILITIES, true)

        expect(rc.setProductHandler).to.have.been.calledWith('ASM_DATA')
        expect(rc.setProductHandler).to.have.been.calledWith('ASM_DD')
        expect(rc.setProductHandler).to.have.been.calledWith('ASM')
        expect(rc.on).to.have.been.calledWithExactly(kPreUpdate, RuleManager.updateWafFromRC)
      })

      it('should activate if appsec is manually enabled', () => {
        config.appsec = { enabled: true, rasp: { enabled: true } }
        remoteConfig.enable(config)
        remoteConfig.enableWafUpdate(config.appsec)

        expectCapabilitiesCalledWith(ALL_ASM_CAPABILITIES, true)

        expect(rc.setProductHandler).to.have.been.calledWith('ASM_DATA')
        expect(rc.setProductHandler).to.have.been.calledWith('ASM_DD')
        expect(rc.setProductHandler).to.have.been.calledWith('ASM')
        expect(rc.on).to.have.been.calledWithExactly(kPreUpdate, RuleManager.updateWafFromRC)
      })

      it('should activate if appsec enabled is not defined', () => {
        config.appsec = { rasp: { enabled: true } }
        remoteConfig.enable(config)
        remoteConfig.enableWafUpdate(config.appsec)

        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_ACTIVATION, true)

        expectCapabilitiesCalledWith(ALL_ASM_CAPABILITIES, true)
      })

      it('should not activate rasp capabilities if rasp is disabled', () => {
        config.appsec = { rasp: { enabled: false } }
        remoteConfig.enable(config)
        remoteConfig.enableWafUpdate(config.appsec)

        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_ACTIVATION, true)

        expectCapabilitiesCalledWith(CORE_ASM_CAPABILITIES, true)
        expectCapabilitiesNotCalled(RASP_CAPABILITIES)
      })
    })

    describe('disable', () => {
      it('should update capabilities and unsubscribe listener', () => {
        remoteConfig.enable(config)
        rc.updateCapabilities.resetHistory()
        remoteConfig.disableWafUpdate()

        expectCapabilitiesCalledWith(ALL_ASM_CAPABILITIES, false)

        expect(rc.removeProductHandler).to.have.been.calledWith('ASM_DATA')
        expect(rc.removeProductHandler).to.have.been.calledWith('ASM_DD')
        expect(rc.removeProductHandler).to.have.been.calledWith('ASM')
        expect(rc.off).to.have.been.calledWithExactly(kPreUpdate, RuleManager.updateWafFromRC)
      })
    })
  })
})
