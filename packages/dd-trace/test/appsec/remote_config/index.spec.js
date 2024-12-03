'use strict'

const RemoteConfigCapabilities = require('../../../src/appsec/remote_config/capabilities')
const { kPreUpdate } = require('../../../src/appsec/remote_config/manager')

let config
let rc
let RemoteConfigManager
let RuleManager
let appsec
let remoteConfig

describe('Remote Config index', () => {
  beforeEach(() => {
    config = {
      appsec: {
        enabled: undefined
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

    RuleManager = {
      updateWafFromRC: sinon.stub()
    }

    appsec = {
      enable: sinon.spy(),
      disable: sinon.spy()
    }

    remoteConfig = proxyquire('../src/appsec/remote_config', {
      './manager': RemoteConfigManager,
      '../rule_manager': RuleManager,
      '..': appsec
    })
  })

  describe('enable', () => {
    it('should listen to remote config when appsec is not explicitly configured', () => {
      config.appsec = { enabled: undefined }

      remoteConfig.enable(config)

      expect(RemoteConfigManager).to.have.been.calledOnceWithExactly(config)
      expect(rc.updateCapabilities).to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_ACTIVATION, true)
      expect(rc.setProductHandler).to.have.been.calledWith('ASM_FEATURES')
      expect(rc.setProductHandler.firstCall.args[1]).to.be.a('function')
    })

    it('should listen to remote config when appsec is explicitly configured as enabled=true', () => {
      config.appsec = { enabled: true }

      remoteConfig.enable(config)

      expect(RemoteConfigManager).to.have.been.calledOnceWithExactly(config)
      expect(rc.updateCapabilities).to.not.have.been.calledWith('ASM_ACTIVATION')
      expect(rc.setProductHandler).to.have.been.calledOnceWith('ASM_FEATURES')
      expect(rc.setProductHandler.firstCall.args[1]).to.be.a('function')
    })

    it('should not listen to remote config when appsec is explicitly configured as enabled=false', () => {
      config.appsec = { enabled: false }

      remoteConfig.enable(config)

      expect(RemoteConfigManager).to.have.been.calledOnceWithExactly(config)
      expect(rc.updateCapabilities).to.not.have.been.calledWith(RemoteConfigCapabilities.ASM_ACTIVATION, true)
      expect(rc.setProductHandler).to.not.have.been.called
    })

    describe('ASM_FEATURES remote config listener', () => {
      let listener

      beforeEach(() => {
        config.appsec = { enabled: undefined }

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

      it('should disable appsec when listener is called with unnaply and enabled', () => {
        listener('unnaply', { asm: { enabled: true } })

        expect(appsec.disable).to.have.been.calledOnce
      })

      it('should not do anything when listener is called with apply and malformed data', () => {
        listener('apply', {})

        expect(appsec.enable).to.not.have.been.called
        expect(appsec.disable).to.not.have.been.called
      })
    })
  })

  describe('enableWafUpdate', () => {
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

        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_IP_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_USER_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_EXCLUSIONS, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_REQUEST_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RESPONSE_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_RULES, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_TRUSTED_IPS, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_ENDPOINT_FINGERPRINT, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_NETWORK_FINGERPRINT, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_HEADER_FINGERPRINT, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_SSRF, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_SQLI, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_LFI, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_SHI, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_CMDI, true)

        expect(rc.setProductHandler).to.have.been.calledWith('ASM_DATA')
        expect(rc.setProductHandler).to.have.been.calledWith('ASM_DD')
        expect(rc.setProductHandler).to.have.been.calledWith('ASM')
        expect(rc.on).to.have.been.calledWithExactly(kPreUpdate, RuleManager.updateWafFromRC)
      })

      it('should activate if appsec is manually enabled', () => {
        config.appsec = { enabled: true, rasp: { enabled: true } }
        remoteConfig.enable(config)
        remoteConfig.enableWafUpdate(config.appsec)

        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_IP_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_USER_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_EXCLUSIONS, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_REQUEST_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RESPONSE_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_RULES, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_TRUSTED_IPS, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_ENDPOINT_FINGERPRINT, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_NETWORK_FINGERPRINT, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_HEADER_FINGERPRINT, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_SSRF, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_SQLI, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_LFI, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_SHI, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_CMDI, true)

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
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_IP_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_USER_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_EXCLUSIONS, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_REQUEST_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RESPONSE_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_RULES, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_TRUSTED_IPS, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_ENDPOINT_FINGERPRINT, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_NETWORK_FINGERPRINT, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_HEADER_FINGERPRINT, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_SSRF, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_SQLI, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_LFI, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_SHI, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_CMDI, true)
      })

      it('should not activate rasp capabilities if rasp is disabled', () => {
        config.appsec = { rasp: { enabled: false } }
        remoteConfig.enable(config)
        remoteConfig.enableWafUpdate(config.appsec)

        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_ACTIVATION, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_IP_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_USER_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_EXCLUSIONS, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_REQUEST_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RESPONSE_BLOCKING, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_RULES, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_TRUSTED_IPS, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_ENDPOINT_FINGERPRINT, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_NETWORK_FINGERPRINT, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_HEADER_FINGERPRINT, true)
        expect(rc.updateCapabilities)
          .to.not.have.been.calledWith(RemoteConfigCapabilities.ASM_RASP_SSRF)
        expect(rc.updateCapabilities)
          .to.not.have.been.calledWith(RemoteConfigCapabilities.ASM_RASP_SQLI)
        expect(rc.updateCapabilities)
          .to.not.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_LFI)
        expect(rc.updateCapabilities)
          .to.not.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_SHI)
        expect(rc.updateCapabilities)
          .to.not.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_CMDI)
      })
    })

    describe('disable', () => {
      it('should update capabilities and unsubscribe listener', () => {
        remoteConfig.enable(config)
        rc.updateCapabilities.resetHistory()
        remoteConfig.disableWafUpdate()

        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_IP_BLOCKING, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_USER_BLOCKING, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_DD_RULES, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_EXCLUSIONS, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_REQUEST_BLOCKING, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RESPONSE_BLOCKING, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_RULES, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_TRUSTED_IPS, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_ENDPOINT_FINGERPRINT, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_NETWORK_FINGERPRINT, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_HEADER_FINGERPRINT, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_SSRF, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_SQLI, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_LFI, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_SHI, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_RASP_CMDI, false)

        expect(rc.removeProductHandler).to.have.been.calledWith('ASM_DATA')
        expect(rc.removeProductHandler).to.have.been.calledWith('ASM_DD')
        expect(rc.removeProductHandler).to.have.been.calledWith('ASM')
        expect(rc.off).to.have.been.calledWithExactly(kPreUpdate, RuleManager.updateWafFromRC)
      })
    })
  })
})
