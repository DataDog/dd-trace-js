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
      off: sinon.spy()
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
      expect(rc.updateCapabilities).to.have.been.calledOnceWithExactly(RemoteConfigCapabilities.ASM_ACTIVATION, true)
      expect(rc.on).to.have.been.calledOnceWith('ASM_FEATURES')
      expect(rc.on.firstCall.args[1]).to.be.a('function')
    })

    it('should not listen to remote config when appsec is explicitly configured', () => {
      config.appsec = { enabled: false }

      remoteConfig.enable(config)

      expect(RemoteConfigManager).to.have.been.calledOnceWithExactly(config)
      expect(rc.updateCapabilities).to.not.have.been.called
      expect(rc.on).to.not.have.been.called
    })

    describe('ASM_FEATURES remote config listener', () => {
      let listener

      beforeEach(() => {
        config.appsec = { enabled: undefined }

        remoteConfig.enable(config)

        listener = rc.on.firstCall.args[1]
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
        expect(rc.on).to.not.have.been.called
      })

      it('should not enable when custom appsec rules are provided', () => {
        config.appsec = { enabled: true, rules: {}, customRulesProvided: true }
        remoteConfig.enable(config)
        remoteConfig.enableWafUpdate(config.appsec)

        expect(rc.updateCapabilities).to.not.have.been.called
        expect(rc.on).to.not.have.been.called
      })

      it('should enable when using default rules', () => {
        config.appsec = { enabled: true, rules: {}, customRulesProvided: false }
        remoteConfig.enable(config)
        remoteConfig.enableWafUpdate(config.appsec)

        expect(rc.updateCapabilities.callCount).to.be.equal(8)
        expect(rc.updateCapabilities.getCall(0))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_IP_BLOCKING, true)
        expect(rc.updateCapabilities.getCall(1))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_USER_BLOCKING, true)
        expect(rc.updateCapabilities.getCall(2))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.updateCapabilities.getCall(3))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_EXCLUSIONS, true)
        expect(rc.updateCapabilities.getCall(4))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_REQUEST_BLOCKING, true)
        expect(rc.updateCapabilities.getCall(5))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_RULES, true)
        expect(rc.updateCapabilities.getCall(6))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, true)
        expect(rc.updateCapabilities.getCall(7))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_TRUSTED_IPS, true)

        expect(rc.on.callCount).to.be.equal(4)
        expect(rc.on.getCall(0)).to.have.been.calledWith('ASM_DATA')
        expect(rc.on.getCall(1)).to.have.been.calledWith('ASM_DD')
        expect(rc.on.getCall(2)).to.have.been.calledWith('ASM')
        expect(rc.on.getCall(3)).to.have.been.calledWithExactly(kPreUpdate, RuleManager.updateWafFromRC)
      })

      it('should activate if appsec is manually enabled', () => {
        config.appsec = { enabled: true }
        remoteConfig.enable(config)
        remoteConfig.enableWafUpdate(config.appsec)

        expect(rc.updateCapabilities.callCount).to.be.equal(8)
        expect(rc.updateCapabilities.getCall(0))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_IP_BLOCKING, true)
        expect(rc.updateCapabilities.getCall(1))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_USER_BLOCKING, true)
        expect(rc.updateCapabilities.getCall(2))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.updateCapabilities.getCall(3))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_EXCLUSIONS, true)
        expect(rc.updateCapabilities.getCall(4))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_REQUEST_BLOCKING, true)
        expect(rc.updateCapabilities.getCall(5))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_RULES, true)
        expect(rc.updateCapabilities.getCall(6))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, true)
        expect(rc.updateCapabilities.getCall(7))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_TRUSTED_IPS, true)

        expect(rc.on.callCount).to.be.equal(4)
        expect(rc.on.getCall(0)).to.have.been.calledWith('ASM_DATA')
        expect(rc.on.getCall(1)).to.have.been.calledWith('ASM_DD')
        expect(rc.on.getCall(2)).to.have.been.calledWith('ASM')
        expect(rc.on.getCall(3)).to.have.been.calledWithExactly(kPreUpdate, RuleManager.updateWafFromRC)
      })

      it('should activate if appsec enabled is not defined', () => {
        config.appsec = {}
        remoteConfig.enable(config)
        remoteConfig.enableWafUpdate(config.appsec)

        expect(rc.updateCapabilities.callCount).to.be.equal(9)
        expect(rc.updateCapabilities.getCall(0))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_ACTIVATION, true)
        expect(rc.updateCapabilities.getCall(1))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_IP_BLOCKING, true)
        expect(rc.updateCapabilities.getCall(2))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_USER_BLOCKING, true)
        expect(rc.updateCapabilities.getCall(3))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.updateCapabilities.getCall(4))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_EXCLUSIONS, true)
        expect(rc.updateCapabilities.getCall(5))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_REQUEST_BLOCKING, true)
        expect(rc.updateCapabilities.getCall(6))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_RULES, true)
        expect(rc.updateCapabilities.getCall(7))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, true)
        expect(rc.updateCapabilities.getCall(8))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_TRUSTED_IPS, true)
      })
    })

    describe('disable', () => {
      it('should update capabilities and unsubscribe listener', () => {
        remoteConfig.enable(config)
        rc.updateCapabilities.resetHistory()
        remoteConfig.disableWafUpdate()

        expect(rc.updateCapabilities.callCount).to.be.equal(8)
        expect(rc.updateCapabilities.getCall(0))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_IP_BLOCKING, false)
        expect(rc.updateCapabilities.getCall(1))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_USER_BLOCKING, false)
        expect(rc.updateCapabilities.getCall(2))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_DD_RULES, false)
        expect(rc.updateCapabilities.getCall(3))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_EXCLUSIONS, false)
        expect(rc.updateCapabilities.getCall(4))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_REQUEST_BLOCKING, false)
        expect(rc.updateCapabilities.getCall(5))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_RULES, false)
        expect(rc.updateCapabilities.getCall(6))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, false)
        expect(rc.updateCapabilities.getCall(7))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_TRUSTED_IPS, false)

        expect(rc.off.callCount).to.be.equal(4)
        expect(rc.off.getCall(0)).to.have.been.calledWith('ASM_DATA')
        expect(rc.off.getCall(1)).to.have.been.calledWith('ASM_DD')
        expect(rc.off.getCall(2)).to.have.been.calledWith('ASM')
        expect(rc.off.getCall(3)).to.have.been.calledWithExactly(kPreUpdate, RuleManager.updateWafFromRC)
      })
    })
  })
})
