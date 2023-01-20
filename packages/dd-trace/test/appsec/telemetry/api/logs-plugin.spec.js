const { expect } = require('chai')
const proxyquire = require('proxyquire')

describe('telemetry logs', () => {
  let defaultConfig
  let onTelemetryStartMsg
  let telemetryStartChannel
  let telemetryStopChannel
  let onTelemetryStart
  let onTelemetryStop
  let dc
  const application = {}
  const host = {}
  const heartbeatInterval = 60000

  beforeEach(() => {
    defaultConfig = {
      enabled: true,
      logCollection: true,
      debug: false
    }

    onTelemetryStartMsg = { config: defaultConfig, application: {}, host: {}, heartbeatInterval: 60000 }

    telemetryStartChannel = {
      get hasSubscribers () {
        return this.subscribe.callCount > 0
      },
      subscribe: sinon.stub(),
      unsubscribe: sinon.stub()
    }

    telemetryStopChannel = {
      get hasSubscribers () {
        return this.subscribe.callCount > 0
      },
      subscribe: sinon.stub(),
      unsubscribe: sinon.stub()
    }

    dc = {
      channel: (name) => name === 'datadog:telemetry:start' ? telemetryStartChannel : telemetryStopChannel
    }

    onTelemetryStart = () => telemetryStartChannel.subscribe.called
      ? telemetryStartChannel.subscribe.getCall(0).args[0] : function () {}
    onTelemetryStop = () => telemetryStopChannel.subscribe.called
      ? telemetryStopChannel.subscribe.getCall(0).args[0] : function () {}
  })

  describe('start', () => {
    it('should be enabled by default and subscribe', () => {
      const TelemetryPlugin = proxyquire('../../../../src/appsec/telemetry/api/plugin', {
        '../../../../../diagnostics_channel': dc
      })
      const logs = proxyquire('../../../../src/appsec/telemetry/api/logs-plugin', {
        './plugin': TelemetryPlugin
      })
      const startInterval = sinon.spy(logs, 'startInterval')

      defaultConfig.logCollection = true
      logs.init(defaultConfig)

      onTelemetryStart()({ config: defaultConfig, application, host, heartbeatInterval })

      expect(telemetryStartChannel.subscribe).to.have.been.calledOnce
      expect(telemetryStopChannel.subscribe).to.have.been.calledOnce
      expect(startInterval).to.have.been.calledOnce
    })

    it('should be disabled and not subscribe if DD_TELEMETRY_LOG_COLLECTION_ENABLED = false', () => {
      const TelemetryPlugin = proxyquire('../../../../src/appsec/telemetry/api/plugin', {
        '../../../../../diagnostics_channel': dc
      })
      const logs = proxyquire('../../../../src/appsec/telemetry/api/logs-plugin', {
        './plugin': TelemetryPlugin
      })
      const startInterval = sinon.spy(logs, 'startInterval')

      defaultConfig.logCollection = false
      logs.init(defaultConfig)

      onTelemetryStart()({ config: defaultConfig })

      expect(startInterval).to.have.been.not.called
    })

    it('should call sendData periodically', () => {
      const clock = sinon.useFakeTimers()
      const sendData = sinon.stub()

      let logCollectorCalled = 0
      const logCollector = {
        drain: () => {
          logCollectorCalled++
          return [{ message: 'Error 1', level: 'ERROR' }]
        }
      }

      const TelemetryPlugin = proxyquire('../../../../src/appsec/telemetry/api/plugin', {
        '../../../../../diagnostics_channel': dc,
        '../../../telemetry/send-data': { sendData }
      })
      const logs = proxyquire('../../../../src/appsec/telemetry/api/logs-plugin', {
        './plugin': TelemetryPlugin
      })
      logs.registerProvider(logCollector.drain).init(defaultConfig, logCollector.init)
      onTelemetryStart()(onTelemetryStartMsg)

      clock.tick(60000)
      clock.tick(60000)

      expect(logCollectorCalled).to.be.eq(2)
      expect(sendData).to.have.been.calledTwice
      expect(sendData).to.have.been.calledWith(onTelemetryStartMsg.config,
        onTelemetryStartMsg.application,
        onTelemetryStartMsg.host,
        'logs'
      )
      clock.restore()
    })
  })

  describe('stop', () => {
    it('should unsubscribe configured listeners', () => {
      const TelemetryPlugin = proxyquire('../../../../src/appsec/telemetry/api/plugin', {
        '../../../../../diagnostics_channel': dc
      })
      const logs = proxyquire('../../../../src/appsec/telemetry/api/logs-plugin', {
        './plugin': TelemetryPlugin
      })
      logs.init(defaultConfig)
      onTelemetryStart()(onTelemetryStartMsg)

      logs.stop()

      expect(telemetryStartChannel.unsubscribe).to.have.been.calledOnce
      expect(telemetryStopChannel.unsubscribe).to.have.been.calledOnce
    })

    it('should unsubscribe configured listeners when datadog:telemetry:stop is received', () => {
      const TelemetryPlugin = proxyquire('../../../../src/appsec/telemetry/api/plugin', {
        '../../../../../diagnostics_channel': dc
      })
      const logs = proxyquire('../../../../src/appsec/telemetry/api/logs-plugin', {
        './plugin': TelemetryPlugin
      })
      logs.init(defaultConfig)
      onTelemetryStart()(onTelemetryStartMsg)

      onTelemetryStop()()

      expect(telemetryStartChannel.unsubscribe).to.have.been.calledOnce
      expect(telemetryStopChannel.unsubscribe).to.have.been.calledOnce
    })
  })
})
