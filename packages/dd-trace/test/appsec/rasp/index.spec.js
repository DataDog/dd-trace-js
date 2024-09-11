'use strict'

const proxyquire = require('proxyquire')
const { handleUncaughtExceptionMonitor } = require('../../../src/appsec/rasp')

describe('RASP', () => {
  let rasp, remoteConfig

  beforeEach(() => {
    remoteConfig = {
      enableRaspCapabilities: sinon.stub(),
      disableRaspCapabilities: sinon.stub()
    }

    rasp = proxyquire('../../../src/appsec/rasp', {
      '../remote_config': remoteConfig
    })
  })

  afterEach(() => {
    rasp.disable()
  })

  describe('enable', () => {
    it('should call to enableRaspCapabilities', () => {
      const config = { appsec: {} }
      rasp.enable(config)

      sinon.assert.calledOnceWithExactly(remoteConfig.enableRaspCapabilities, config.appsec)
    })
  })

  describe('disable', () => {
    it('should call to disableRaspCapabilities', () => {
      rasp.disable()

      sinon.assert.calledOnce(remoteConfig.disableRaspCapabilities)
    })
  })

  describe('handleUncaughtExceptionMonitor', () => {
    it('should not break with infinite loop of cause', () => {
      const err = new Error()
      err.cause = err

      handleUncaughtExceptionMonitor(err)
    })
  })
})
