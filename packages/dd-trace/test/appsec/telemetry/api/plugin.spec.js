'use strict'

const { expect } = require('chai')
const proxyquire = require('proxyquire')

const TelemetryPlugin = require('../../../../src/appsec/telemetry/api/plugin')

describe('TelemetryPlugin', () => {
  let onSendData, plugin, clock
  const config = {
    telemetry: {
      enabled: true
    }
  }
  const application = {}
  const host = 'host'

  beforeEach(() => {
    plugin = new TelemetryPlugin('pluginReqType')
    onSendData = sinon.spy(plugin, 'onSendData')
    clock = sinon.useFakeTimers()
  })

  afterEach(() => {
    sinon.reset()
    clock.restore()
  })

  describe('init', () => {
    it('should subscribe only once even if init is called several times', () => {
      const subscribeOnStart = sinon.spy()
      const subscribeOnStop = sinon.spy()
      const TelemetryPlugin = proxyquire('../../../../src/appsec/telemetry/api/plugin', {
        '../../../../../diagnostics_channel': {
          channel: (channelName) => {
            return channelName === 'datadog:telemetry:start'
              ? {
                subscribe: subscribeOnStart
              }
              : {
                subscribe: subscribeOnStop
              }
          }
        }
      })
      plugin = new TelemetryPlugin('pluginReqType')

      plugin.init()
      plugin.init()
      plugin.init()

      expect(subscribeOnStart).to.be.calledOnce
      expect(subscribeOnStop).to.be.calledOnce
    })

    it('should call onStartCallback if provided', () => {
      plugin = new TelemetryPlugin('pluginReqType')

      const onStartCallback = sinon.spy()
      plugin.init(config, onStartCallback)

      plugin.start(config, application, host, 1000)
      expect(onStartCallback).to.be.calledOnceWith(config.telemetry)
    })
  })

  describe('providers', () => {
    it('should register providers and be chainable', () => {
      plugin = new TelemetryPlugin('pluginReqType')

      const provider1 = sinon.spy()
      const provider2 = sinon.spy()
      expect(plugin.registerProvider(provider1)).to.be.eq(plugin)
      expect(plugin.registerProvider(provider2)).to.be.eq(plugin)

      expect(plugin.providers.size).to.be.eq(2)
      expect(plugin.providers.has(provider1)).to.be.true
      expect(plugin.providers.has(provider2)).to.be.true
    })

    it('should not call startInterval after register provider', () => {
      plugin = new TelemetryPlugin('pluginReqType')
      sinon.stub(plugin, 'startInterval')

      const provider1 = sinon.spy()
      const provider2 = sinon.spy()
      expect(plugin.registerProvider(provider1)).to.be.eq(plugin)
      expect(plugin.registerProvider(provider2)).to.be.eq(plugin)

      expect(plugin.startInterval).to.not.be.called
    })

    it('should unregister providers and be chainable', () => {
      plugin = new TelemetryPlugin('pluginReqType')
      const provider = sinon.spy()
      plugin.registerProvider(provider)

      expect(plugin.unregisterProvider(provider)).to.be.eq(plugin)

      expect(plugin.providers.size).to.be.eq(0)
    })

    it('should call stop interval if there are not providers left', () => {
      plugin = new TelemetryPlugin('pluginReqType')
      sinon.stub(plugin, 'stopInterval')
      const provider = sinon.spy()
      plugin.registerProvider(provider)

      expect(plugin.unregisterProvider(provider)).to.be.eq(plugin)

      expect(plugin.providers.size).to.be.eq(0)
      expect(plugin.stopInterval).to.be.calledOnce
    })
  })

  describe('start', () => {
    it('should not set a periodic task to send metrics if no interval is provided', () => {
      plugin.start()
      clock.tick(1000)

      expect(onSendData).to.not.have.been.called
    })

    it('should set a periodic task to send metrics if interval is provided', () => {
      plugin.start(config, application, host, 60000)
      clock.tick(60000)

      expect(onSendData).to.have.been.called
      expect(plugin.interval).to.not.be.null
    })

    it('should call onStart and skip setting a periodic task if value returned by onStart is false', () => {
      const origOnStart = plugin.onStart
      plugin.onStart = () => false
      plugin.start(config, application, host, 60000)
      clock.tick(60000)

      expect(onSendData).to.not.have.been.called
      plugin.onStart = origOnStart
    })
  })

  describe('stop', () => {
    it('should call onStop', () => {
      const metricsOnStop = sinon.stub(plugin, 'onStop')
      plugin.start(config, application, host, 60000)
      plugin.stop()

      expect(metricsOnStop).to.have.been.calledOnce
      metricsOnStop.restore()
    })

    it('should drain providers', () => {
      const provider1 = sinon.spy()
      const provider2 = sinon.spy()
      plugin.registerProvider(provider1)
        .registerProvider(provider2)
        .stop()

      expect(provider1).to.be.calledOnce
      expect(provider2).to.be.calledOnce
    })
  })

  describe('onSendData', () => {
    it('should obtain the payload and send it with sendData', () => {
      const sendDataMock = sinon.stub()
      const TelemetryPlugin = proxyquire('../../../../src/appsec/telemetry/api/plugin', {
        '../../../telemetry/send-data': {
          sendData: sendDataMock
        }
      })
      const plugin = new TelemetryPlugin('pluginReqType')
      const getPayloadMock = sinon.stub(plugin, 'getPayload')
      const payload = { payload: '' }
      getPayloadMock.returns(payload)

      plugin.start(config, application, host)
      plugin.onSendData()

      expect(getPayloadMock).to.have.been.calledOnce
      expect(sendDataMock).to.have.been.calledOnceWith(config, application, host, 'pluginReqType', payload)
    })
  })
})
