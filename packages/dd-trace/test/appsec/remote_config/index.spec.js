'use strict'

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
      updateAsmData: sinon.stub(),
      toggleRules: sinon.stub()
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
    expect(rc.updateCapabilities).to.have.been.calledOnceWithExactly(2n, true)
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
        expect(rc.on).to.not.have.been.calledWith('ASM_DATA')
      })

      it('should not activate if rules is configured', () => {
        config.appsec = { enabled: true, rules: './path/rules.json' }
        remoteConfig.enable(config)
        remoteConfig.enableAsmData(config.appsec)
        expect(rc.on).to.not.have.been.calledWith('ASM_DATA')
      })

      it('should activate if appsec is manually enabled', () => {
        config.appsec = { enabled: true }
        remoteConfig.enable(config)
        remoteConfig.enableAsmData(config.appsec)
        expect(rc.on).to.have.been.calledOnceWith('ASM_DATA')
      })

      it('should activate if appsec enabled is not defined', () => {
        config.appsec = {}
        remoteConfig.enable(config)
        remoteConfig.enableAsmData(config.appsec)
        expect(rc.on.lastCall).to.have.been.calledWith('ASM_DATA')
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

      it('should call RuleManager.toggleRules', () => {
        const rulesOverride = {
          rules_override: [
            {
              enabled: false,
              id: 'crs-941-300'
            },
            {
              enabled: false,
              id: 'test-3'
            }
          ]
        }
        listener('apply', rulesOverride, 'asm')

        expect(RuleManager.toggleRules).to.have.been.calledOnceWithExactly('apply', rulesOverride, 'asm')
      })
    })

    describe('enable', () => {
      it('should subscribe to listener and update capabilities no rules file is provided', () => {
        config.appsec = { enabled: true }
        remoteConfig.enable(config)
        remoteConfig.enableAsm(config.appsec)
        expect(rc.updateCapabilities).to.have.been.calledOnceWith(RemoteConfigCapabilities.ASM_DD_RULES, true)
        expect(rc.on).to.have.been.calledOnceWith('ASM')
      })

      it('should not fail if remote config is not enabled before', () => {
        config.appsec = {}
        remoteConfig.enableAsm(config.appsec)
        expect(rc.on).to.not.have.been.called
        expect(rc.updateCapabilities).to.not.have.been.called
      })

      it('should not subscribe to listener nor update capabilities if rules file is provided', () => {
        config.appsec = { enabled: true, rules: './path/rules.json' }
        remoteConfig.enable(config)
        remoteConfig.enableAsm(config.appsec)
        expect(rc.updateCapabilities).to.not.have.been.called
        expect(rc.on).to.not.have.been.called
      })
    })

    describe('disable', () => {
      it('should update capabilities and unsubscribe from listener', () => {
        remoteConfig.enable(config)
        rc.updateCapabilities.resetHistory()
        remoteConfig.disableAsm()
        expect(rc.updateCapabilities).to.have.been.calledOnceWith(RemoteConfigCapabilities.ASM_DD_RULES, false)
        expect(rc.off).to.have.been.calledOnceWith('ASM')
      })
    })
  })
})
