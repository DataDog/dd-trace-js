'use strict'

const RemoteConfigCapabilities = require('../../../src/appsec/remote_config/capabilities')

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

      it('should not activate if rules is configured', () => {
        config.appsec = { enabled: true, rules: './path/rules.json' }
        remoteConfig.enable(config)
        remoteConfig.enableWafUpdate(config.appsec)

        expect(rc.updateCapabilities).to.not.have.been.called
        expect(rc.on).to.not.have.been.called
      })

      it('should activate if appsec is manually enabled', () => {
        config.appsec = { enabled: true }
        remoteConfig.enable(config)
        remoteConfig.enableWafUpdate(config.appsec)

        expect(rc.updateCapabilities.callCount).to.be.equal(4)
        expect(rc.updateCapabilities.getCall(0))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_IP_BLOCKING, true)
        expect(rc.updateCapabilities.getCall(1))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_USER_BLOCKING, true)
        expect(rc.updateCapabilities.getCall(2))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.updateCapabilities.getCall(3))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_EXCLUSIONS, true)
      })

      it('should activate if appsec enabled is not defined', () => {
        config.appsec = {}
        remoteConfig.enable(config)
        remoteConfig.enableWafUpdate(config.appsec)

        expect(rc.updateCapabilities.callCount).to.be.equal(5)
        expect(rc.updateCapabilities.firstCall)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_ACTIVATION, true)
        expect(rc.updateCapabilities.secondCall)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_IP_BLOCKING, true)
        expect(rc.updateCapabilities.thirdCall)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_USER_BLOCKING, true)
        expect(rc.updateCapabilities.getCall(3))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.updateCapabilities.getCall(4))
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_EXCLUSIONS, true)
      })
    })

    describe('disable', () => {
      it('should update capabilities and unsubscribe listener', () => {
        remoteConfig.enable(config)
        rc.updateCapabilities.resetHistory()
        remoteConfig.disableWafUpdate()

        expect(rc.updateCapabilities.callCount).to.be.equal(4)
        expect(rc.updateCapabilities.firstCall)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_IP_BLOCKING, false)
        expect(rc.updateCapabilities.secondCall)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_USER_BLOCKING, false)
        expect(rc.off).to.have.been.called
      })
    })
  })
})
