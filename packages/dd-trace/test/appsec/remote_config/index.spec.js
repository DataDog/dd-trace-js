'use strict'

const Capabilities = require('../../../src/appsec/remote_config/capabilities')
const RemoteConfigCapabilities = require('../../../src/appsec/remote_config/capabilities')

let config
let rc
let RemoteConfigManager
let appsec
let remoteConfig
let RuleManager

describe('Remote Config enable', () => {
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

    appsec = {
      enable: sinon.spy(),
      enableAsync: sinon.spy(() => Promise.resolve()),
      disable: sinon.spy()
    }

    RuleManager = {
      updateAsm: sinon.stub(),
      updateAsmData: sinon.stub(),
      updateAsmDDRules: sinon.stub()
    }

    remoteConfig = proxyquire('../src/appsec/remote_config', {
      './manager': RemoteConfigManager,
      '..': appsec,
      '../rule_manager': RuleManager
    })
  })

  it('should listen to remote config when appsec is not explicitly configured', () => {
    config.appsec = { enabled: undefined }

    remoteConfig.enable(config)

    expect(RemoteConfigManager).to.have.been.calledOnceWith(config)
    expect(rc.updateCapabilities).to.have.been.calledOnceWithExactly(Capabilities.ASM_ACTIVATION, true)
    expect(rc.on).to.have.been.calledOnceWith('ASM_FEATURES')
    expect(rc.on.firstCall.args[1]).to.be.a('function')
  })

  it('should not listen to remote config when appsec is explicitly configured', () => {
    config.appsec = { enabled: false }

    remoteConfig.enable(config)

    expect(RemoteConfigManager).to.have.been.calledOnceWith(config)
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

      expect(appsec.enable).to.not.have.been.called
      expect(appsec.enableAsync).to.have.been.calledOnceWithExactly(config)
    })

    it('should enable appsec when listener is called with modify and enabled', () => {
      listener('modify', { asm: { enabled: true } })

      expect(appsec.enable).to.not.have.been.called
      expect(appsec.enableAsync).to.have.been.calledOnceWithExactly(config)
    })

    it('should disable appsec when listener is called with unnaply and enabled', () => {
      listener('unnaply', { asm: { enabled: true } })

      expect(appsec.disable).to.have.been.calledOnce
    })

    it('should not do anything when listener is called with apply and malformed data', () => {
      listener('apply', {})

      expect(appsec.enableAsync).to.not.have.been.called
      expect(appsec.enable).to.not.have.been.called
      expect(appsec.disable).to.not.have.been.called
    })
  })

  describe('ASM_DATA remote config', () => {
    describe('listener', () => {
      let listener

      beforeEach(() => {
        config.appsec = { enabled: undefined }

        remoteConfig.enable(config)
        remoteConfig.enableAsmData(config.appsec)

        listener = rc.on.secondCall.args[1]
      })

      it('should call RuleManager.updateAsmData', () => {
        const ruleData = {
          rules_data: [{
            data: [
              { value: 'user1' }
            ],
            id: 'blocked_users',
            type: 'data_with_expiration'
          }]
        }
        listener('apply', ruleData, 'asm_data')

        expect(RuleManager.updateAsmData).to.have.been.calledOnceWithExactly('apply', ruleData, 'asm_data')
      })
    })

    describe('enable', () => {
      it('should not fail if remote config is not enabled before', () => {
        config.appsec = {}
        remoteConfig.enableAsmData(config.appsec)

        expect(rc.updateCapabilities).to.not.have.been.called
        expect(rc.on).to.not.have.been.calledWith('ASM_DATA')
      })

      it('should not activate if rules is configured', () => {
        config.appsec = { enabled: true, rules: './path/rules.json' }
        remoteConfig.enable(config)
        remoteConfig.enableAsmData(config.appsec)

        expect(rc.updateCapabilities).to.not.have.been.called
        expect(rc.on).to.not.have.been.calledWith('ASM_DATA')
      })

      it('should activate if appsec is manually enabled', () => {
        config.appsec = { enabled: true }
        remoteConfig.enable(config)
        remoteConfig.enableAsmData(config.appsec)

        expect(rc.updateCapabilities).to.have.been.calledTwice
        expect(rc.updateCapabilities.firstCall).to.have.been.calledWithExactly(Capabilities.ASM_IP_BLOCKING, true)
        expect(rc.updateCapabilities.secondCall).to.have.been.calledWithExactly(Capabilities.ASM_USER_BLOCKING, true)
        expect(rc.on).to.have.been.calledOnceWith('ASM_DATA')
      })

      it('should activate if appsec enabled is not defined', () => {
        config.appsec = {}
        remoteConfig.enable(config)
        remoteConfig.enableAsmData(config.appsec)

        expect(rc.updateCapabilities).to.have.been.calledThrice
        expect(rc.updateCapabilities.firstCall).to.have.been.calledWithExactly(Capabilities.ASM_ACTIVATION, true)
        expect(rc.updateCapabilities.secondCall).to.have.been.calledWithExactly(Capabilities.ASM_IP_BLOCKING, true)
        expect(rc.updateCapabilities.thirdCall).to.have.been.calledWithExactly(Capabilities.ASM_USER_BLOCKING, true)
        expect(rc.on.lastCall).to.have.been.calledWith('ASM_DATA')
      })
    })

    describe('disable', () => {
      it('should update capabilities and unsubscribe listener', () => {
        remoteConfig.enable(config)
        rc.updateCapabilities.resetHistory()
        remoteConfig.disableAsmData()

        expect(rc.updateCapabilities).to.have.been.calledTwice
        expect(rc.updateCapabilities.firstCall).to.have.been.calledWithExactly(Capabilities.ASM_IP_BLOCKING, false)
        expect(rc.updateCapabilities.secondCall).to.have.been.calledWithExactly(Capabilities.ASM_USER_BLOCKING, false)
        expect(rc.off).to.be.calledOnce
      })
    })
  })

  describe('ASM_DD remote config', () => {
    describe('listener', () => {
      let listener

      beforeEach(() => {
        config.appsec = { enabled: undefined }

        remoteConfig.enable(config)
        remoteConfig.enableAsmDDRules(config.appsec)
        listener = rc.on.secondCall.args[1]
      })

      it('should call RuleManager.updateAsmDDRules', () => {
        const rules = {}
        listener('apply', rules)
        expect(RuleManager.updateAsmDDRules).to.have.been.calledOnceWithExactly('apply', rules)
      })
    })

    describe('enable', () => {
      it('should not fail if remote config is not enabled before', () => {
        config.appsec = {}
        remoteConfig.enableAsmDDRules(config.appsec)
        expect(rc.updateCapabilities).to.not.have.been.calledWith(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.on).to.not.have.been.calledWith('ASM_DD')
      })

      it('should not activate if rules is configured', () => {
        config.appsec = { enabled: true, rules: './path/rules.json' }
        remoteConfig.enable(config)
        remoteConfig.enableAsmDDRules(config.appsec)
        expect(rc.updateCapabilities).to.not.have.been.calledWith(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.on).to.not.have.been.calledWith('ASM_DD')
      })

      it('should activate if appsec is manually enabled', () => {
        config.appsec = { enabled: true }
        remoteConfig.enable(config)
        remoteConfig.enableAsmDDRules(config.appsec)
        expect(rc.updateCapabilities).to.have.been.calledWith(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.on).to.have.been.calledOnceWith('ASM_DD')
      })

      it('should activate if appsec enabled is not defined', () => {
        config.appsec = {}
        remoteConfig.enable(config)
        remoteConfig.enableAsmDDRules(config.appsec)
        expect(rc.updateCapabilities).to.have.been.calledWith(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.on.lastCall).to.have.been.calledWith('ASM_DD')
      })
    })

    describe('disable', () => {
      it('should update capabilities and unsubscribe listener', () => {
        remoteConfig.enable(config)
        rc.updateCapabilities.resetHistory()
        remoteConfig.disableAsmDDRules()
        expect(rc.updateCapabilities).to.have.been.calledOnceWith(RemoteConfigCapabilities.ASM_DD_RULES, false)
        expect(rc.off).to.be.calledOnce
      })
    })
  })

  describe('ASM remote config', () => {
    describe('listener', () => {
      let listener

      beforeEach(() => {
        config.appsec = { enabled: undefined }

        remoteConfig.enable(config)
        remoteConfig.enableAsm(config.appsec)
        listener = rc.on.secondCall.args[1]
      })

      it('should call RuleManager.updateAsmDDRules', () => {
        const rules = {}
        listener('apply', rules)
        expect(RuleManager.updateAsm).to.have.been.calledOnceWithExactly('apply', rules)
      })
    })

    describe('enable', () => {
      it('should not fail if remote config is not enabled before', () => {
        config.appsec = {}
        remoteConfig.enableAsm(config.appsec)
        expect(rc.updateCapabilities).to.not.have.been.calledWith(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.updateCapabilities).to.not.have.been.calledWith(RemoteConfigCapabilities.ASM_EXCLUSIONS, true)
        expect(rc.on).to.not.have.been.calledWith('ASM')
      })

      it('should not activate if rules is configured', () => {
        config.appsec = { enabled: true, rules: './path/rules.json' }
        remoteConfig.enable(config)
        remoteConfig.enableAsm(config.appsec)
        expect(rc.updateCapabilities).to.not.have.been.calledWith(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.updateCapabilities).to.not.have.been.calledWith(RemoteConfigCapabilities.ASM_EXCLUSIONS, true)
        expect(rc.on).to.not.have.been.calledWith('ASM')
      })

      it('should activate if appsec is manually enabled', () => {
        config.appsec = { enabled: true }
        remoteConfig.enable(config)
        remoteConfig.enableAsm(config.appsec)
        expect(rc.updateCapabilities).to.have.been.calledWith(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.updateCapabilities).to.have.been.calledWith(RemoteConfigCapabilities.ASM_EXCLUSIONS, true)
        expect(rc.on).to.have.been.calledOnceWith('ASM')
      })

      it('should activate if appsec enabled is not defined', () => {
        config.appsec = {}
        remoteConfig.enable(config)
        remoteConfig.enableAsm(config.appsec)
        expect(rc.updateCapabilities).to.have.been.calledWith(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.updateCapabilities).to.have.been.calledWith(RemoteConfigCapabilities.ASM_EXCLUSIONS, true)
        expect(rc.on).to.have.been.calledWith('ASM')
      })
    })

    describe('disable', () => {
      it('should update capabilities and unsubscribe listener', () => {
        remoteConfig.enable(config)
        rc.updateCapabilities.resetHistory()
        remoteConfig.disableAsm()
        expect(rc.updateCapabilities).to.have.been.calledWith(RemoteConfigCapabilities.ASM_DD_RULES, false)
        expect(rc.updateCapabilities).to.have.been.calledWith(RemoteConfigCapabilities.ASM_EXCLUSIONS, false)
        expect(rc.off).to.be.calledOnce
      })
    })
  })
})
