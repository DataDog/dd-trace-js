'use strict'

require('../../../../dd-trace/test/setup/tap')

let config
let rc
let RemoteConfigManager
let appsec
let remoteConfig

describe('Remote Config enable', () => {
  beforeEach(() => {
    config = {
      appsec: {
        enabled: undefined
      }
    }

    rc = {
      updateCapabilities: sinon.spy(),
      on: sinon.spy()
    }

    RemoteConfigManager = sinon.stub().returns(rc)

    appsec = {
      enable: sinon.spy(),
      disable: sinon.spy()
    }

    remoteConfig = proxyquire('../src/appsec/remote_config', {
      './manager': RemoteConfigManager,
      '..': appsec
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

      expect(appsec.enable).to.have.been.calledOnceWithExactly(config)
    })

    it('should enable appsec when listener is called with modify and enabled', () => {
      listener('modify', { asm: { enabled: true } })

      expect(appsec.enable).to.have.been.calledOnceWithExactly(config)
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
