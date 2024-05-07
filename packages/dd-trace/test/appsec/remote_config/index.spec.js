'use strict'

const RemoteConfigCapabilities = require('../../../src/appsec/remote_config/capabilities')
const { kPreUpdate } = require('../../../src/appsec/remote_config/manager')

let config
let rc
let RemoteConfigManager
let RuleManager
let appsec
let remoteConfig
let apiSecuritySampler

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

    apiSecuritySampler = {
      configure: sinon.stub(),
      setRequestSampling: sinon.stub()
    }

    appsec = {
      enable: sinon.spy(),
      disable: sinon.spy()
    }

    remoteConfig = proxyquire('../src/appsec/remote_config', {
      './manager': RemoteConfigManager,
      '../rule_manager': RuleManager,
      '../api_security_sampler': apiSecuritySampler,
      '..': appsec
    })
  })

  describe('enable', () => {
    it('should listen to remote config when appsec is not explicitly configured', () => {
      config.appsec = { enabled: undefined }

      remoteConfig.enable(config)

      expect(RemoteConfigManager).to.have.been.calledOnceWithExactly(config)
      expect(rc.updateCapabilities).to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_ACTIVATION, true)
      expect(rc.on).to.have.been.calledWith('ASM_FEATURES')
      expect(rc.on.firstCall.args[1]).to.be.a('function')
    })

    it('should listen to remote config when appsec is explicitly configured as enabled=true', () => {
      config.appsec = { enabled: true }

      remoteConfig.enable(config)

      expect(RemoteConfigManager).to.have.been.calledOnceWithExactly(config)
      expect(rc.updateCapabilities).to.not.have.been.calledWith('ASM_ACTIVATION')
      expect(rc.on).to.have.been.calledOnceWith('ASM_FEATURES')
      expect(rc.on.firstCall.args[1]).to.be.a('function')
    })

    it('should not listen to remote config when appsec is explicitly configured as enabled=false', () => {
      config.appsec = { enabled: false }

      remoteConfig.enable(config)

      expect(RemoteConfigManager).to.have.been.calledOnceWithExactly(config)
      expect(rc.updateCapabilities).to.not.have.been.calledWith(RemoteConfigCapabilities.ASM_ACTIVATION, true)
      expect(rc.on).to.not.have.been.called
    })

    it('should listen ASM_API_SECURITY_SAMPLE_RATE when appsec.enabled=undefined and appSecurity.enabled=true', () => {
      config.appsec = { enabled: undefined, apiSecurity: { enabled: true } }

      remoteConfig.enable(config)

      expect(RemoteConfigManager).to.have.been.calledOnceWithExactly(config)
      expect(rc.updateCapabilities)
        .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_ACTIVATION, true)
      expect(rc.updateCapabilities)
        .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_API_SECURITY_SAMPLE_RATE, true)
    })

    it('should listen ASM_API_SECURITY_SAMPLE_RATE when appsec.enabled=true and appSecurity.enabled=true', () => {
      config.appsec = { enabled: true, apiSecurity: { enabled: true } }

      remoteConfig.enable(config)

      expect(RemoteConfigManager).to.have.been.calledOnceWithExactly(config)
      expect(rc.updateCapabilities)
        .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_API_SECURITY_SAMPLE_RATE, true)
    })

    describe('ASM_FEATURES remote config listener', () => {
      let listener

      beforeEach(() => {
        config.appsec = { enabled: undefined }

        remoteConfig.enable(config, appsec)

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

    describe('API Security Request Sampling', () => {
      describe('OneClick', () => {
        let listener

        beforeEach(() => {
          config = {
            appsec: {
              enabled: undefined,
              apiSecurity: {
                requestSampling: 0.1
              }
            }
          }

          remoteConfig.enable(config)

          listener = rc.on.firstCall.args[1]
        })

        it('should update apiSecuritySampler config', () => {
          listener('apply', {
            api_security: {
              request_sample_rate: 0.5
            }
          })

          expect(apiSecuritySampler.setRequestSampling).to.be.calledOnceWithExactly(0.5)
        })

        it('should update apiSecuritySampler config and disable it', () => {
          listener('apply', {
            api_security: {
              request_sample_rate: 0
            }
          })

          expect(apiSecuritySampler.setRequestSampling).to.be.calledOnceWithExactly(0)
        })

        it('should not update apiSecuritySampler config with values greater than 1', () => {
          listener('apply', {
            api_security: {
              request_sample_rate: 5
            }
          })

          expect(apiSecuritySampler.configure).to.not.be.called
        })

        it('should not update apiSecuritySampler config with values less than 0', () => {
          listener('apply', {
            api_security: {
              request_sample_rate: -0.4
            }
          })

          expect(apiSecuritySampler.configure).to.not.be.called
        })

        it('should not update apiSecuritySampler config with incorrect values', () => {
          listener('apply', {
            api_security: {
              request_sample_rate: 'not_a_number'
            }
          })

          expect(apiSecuritySampler.configure).to.not.be.called
        })
      })

      describe('Enabled', () => {
        let listener

        beforeEach(() => {
          config = {
            appsec: {
              enabled: true,
              apiSecurity: {
                requestSampling: 0.1
              }
            }
          }

          remoteConfig.enable(config)

          listener = rc.on.firstCall.args[1]
        })

        it('should update config apiSecurity.requestSampling property value', () => {
          listener('apply', {
            api_security: {
              request_sample_rate: 0.5
            }
          })

          expect(apiSecuritySampler.setRequestSampling).to.be.calledOnceWithExactly(0.5)
        })
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
        config.appsec = { enabled: true, rules: {} }
        remoteConfig.enable(config)
        remoteConfig.enableWafUpdate(config.appsec)

        expect(rc.updateCapabilities).to.not.have.been.calledWith('ASM_ACTIVATION')
        expect(rc.on).to.have.been.called
      })

      it('should enable when using default rules', () => {
        config.appsec = { enabled: true, rules: null }
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
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_RULES, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_TRUSTED_IPS, true)

        expect(rc.on).to.have.been.calledWith('ASM_DATA')
        expect(rc.on).to.have.been.calledWith('ASM_DD')
        expect(rc.on).to.have.been.calledWith('ASM')
        expect(rc.on).to.have.been.calledWithExactly(kPreUpdate, RuleManager.updateWafFromRC)
      })

      it('should activate if appsec is manually enabled', () => {
        config.appsec = { enabled: true }
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
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_RULES, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_TRUSTED_IPS, true)

        expect(rc.on).to.have.been.calledWith('ASM_DATA')
        expect(rc.on).to.have.been.calledWith('ASM_DD')
        expect(rc.on).to.have.been.calledWith('ASM')
        expect(rc.on).to.have.been.calledWithExactly(kPreUpdate, RuleManager.updateWafFromRC)
      })

      it('should activate if appsec enabled is not defined', () => {
        config.appsec = {}
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
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_RULES, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, true)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_TRUSTED_IPS, true)
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
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_RULES, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_CUSTOM_BLOCKING_RESPONSE, false)
        expect(rc.updateCapabilities)
          .to.have.been.calledWithExactly(RemoteConfigCapabilities.ASM_TRUSTED_IPS, false)

        expect(rc.off).to.have.been.calledWith('ASM_DATA')
        expect(rc.off).to.have.been.calledWith('ASM_DD')
        expect(rc.off).to.have.been.calledWith('ASM')
        expect(rc.off).to.have.been.calledWithExactly(kPreUpdate, RuleManager.updateWafFromRC)
      })
    })
  })
})
