const { expect } = require('chai')
const { match } = require('sinon')
const proxyquire = require('proxyquire')

describe('telemetry logs', () => {
  let defaultConfig
  let onTelemetryStartMsg
  let telemetryStartChannel
  let telemetryStopChannel
  let onTelemetryStart
  let onTelemetryStop
  let dc

  beforeEach(() => {
    defaultConfig = {
      telemetry: {
        enabled: true,
        logCollection: true,
        debug: false
      }
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

    onTelemetryStart = () => telemetryStartChannel.subscribe.getCall(0).args[0]
    onTelemetryStop = () => telemetryStopChannel.subscribe.getCall(0).args[0]
  })

  describe('start', () => {
    it('should be enabled by default and subscribe', () => {
      const logs = proxyquire('../../../../src/appsec/iast/telemetry/logs', {
        'diagnostics_channel': dc
      })
      logs.start()
      defaultConfig.telemetry.logCollection = true

      expect(onTelemetryStart()({ config: defaultConfig })).to.be.true
      expect(telemetryStartChannel.subscribe).to.have.been.calledOnce
      expect(telemetryStopChannel.subscribe).to.have.been.calledOnce
    })

    it('should be disabled and not subscribe if DD_TELEMETRY_LOG_COLLECTION_ENABLED = false', () => {
      const logs = proxyquire('../../../../src/appsec/iast/telemetry/logs', {
        'diagnostics_channel': dc
      })
      logs.start()

      defaultConfig.telemetry.logCollection = false

      expect(onTelemetryStart()({ config: defaultConfig })).to.be.false
    })

    it('should call sendData periodically', () => {
      const clock = sinon.useFakeTimers()
      const sendData = sinon.stub()

      let logCollectorCalled = 0
      const logs = proxyquire('../../../../src/appsec/iast/telemetry/logs', {
        'diagnostics_channel': dc,
        '../../../telemetry/send-data': { sendData },
        './log_collector': {
          drain: () => {
            logCollectorCalled++
            return { message: 'Error 1', level: 'ERROR' }
          }
        }
      })
      logs.start()
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
      const logs = proxyquire('../../../../src/appsec/iast/telemetry/logs', {
        'diagnostics_channel': dc
      })
      logs.start()
      onTelemetryStart()(onTelemetryStartMsg)

      logs.stop()

      expect(telemetryStartChannel.unsubscribe).to.have.been.calledOnce
      expect(telemetryStopChannel.unsubscribe).to.have.been.calledOnce
    })

    it('should unsubscribe configured listeners when datadog:telemetry:stop is received', () => {
      const logs = proxyquire('../../../../src/appsec/iast/telemetry/logs', {
        'diagnostics_channel': dc
      })
      logs.start()
      onTelemetryStart()(onTelemetryStartMsg)

      onTelemetryStop()()

      expect(telemetryStartChannel.unsubscribe).to.have.been.calledOnce
      expect(telemetryStopChannel.unsubscribe).to.have.been.calledOnce
    })
  })

  describe('sendData', () => {
    const app = {}
    const host = {}

    it('should be called with DEBUG level and error if config.telemetry.debug = true', () => {
      const logCollectorAdd = sinon.stub()
      const logs = proxyquire('../../../../src/appsec/iast/telemetry/logs', {
        'diagnostics_channel': dc,
        './log_collector': {
          add: logCollectorAdd
        }
      })
      logs.start()

      onTelemetryStartMsg.config.telemetry.debug = true
      onTelemetryStartMsg.application = app
      onTelemetryStartMsg.host = host
      onTelemetryStart()(onTelemetryStartMsg)

      const error = new Error('test')
      const stack = error.stack
      logs.publish({ message: error.message, stack_trace: stack, level: 'DEBUG' })

      expect(logCollectorAdd).to.be.calledOnceWith(match({ message: 'test', level: 'DEBUG', stack_trace: stack }))
    })

    it('should be not called with DEBUG level if config.telemetry.debug = false', () => {
      const logCollectorAdd = sinon.stub()
      const logs = proxyquire('../../../../src/appsec/iast/telemetry/logs', {
        'diagnostics_channel': dc,
        './log_collector': {
          add: logCollectorAdd
        }
      })
      logs.start()
      onTelemetryStart()(onTelemetryStartMsg)

      logs.publish({ message: 'message', level: 'DEBUG' })

      expect(logCollectorAdd).to.not.be.called
    })

    it('should be called with WARN level', () => {
      const logCollectorAdd = sinon.stub()
      const logs = proxyquire('../../../../src/appsec/iast/telemetry/logs', {
        'diagnostics_channel': dc,
        './log_collector': {
          add: logCollectorAdd
        }
      })
      logs.start()
      onTelemetryStart()(onTelemetryStartMsg)

      logs.publish({ message: 'message', level: 'WARN' })

      expect(logCollectorAdd).to.be.calledOnceWith(match({ message: 'message', level: 'WARN' }))
    })

    it('should be called with ERROR level', () => {
      const logCollectorAdd = sinon.stub()
      const logs = proxyquire('../../../../src/appsec/iast/telemetry/logs', {
        'diagnostics_channel': dc,
        './log_collector': {
          add: logCollectorAdd
        }
      })
      logs.start()
      onTelemetryStart()(onTelemetryStartMsg)

      logs.publish({ message: 'message', level: 'ERROR' })

      expect(logCollectorAdd).to.be.calledOnceWith(match({ message: 'message', level: 'ERROR' }))
    })

    it('should be called with ERROR level and stack_trace', () => {
      const logCollectorAdd = sinon.stub()
      const logs = proxyquire('../../../../src/appsec/iast/telemetry/logs', {
        'diagnostics_channel': dc,
        './log_collector': {
          add: logCollectorAdd
        }
      })
      logs.start()
      onTelemetryStart()(onTelemetryStartMsg)

      const error = new Error('message')
      const stack = error.stack
      logs.publish({ message: error.message, stack_trace: stack, level: 'ERROR' })

      expect(logCollectorAdd).to.be.calledOnceWith(match({ message: 'message', level: 'ERROR', stack_trace: stack }))
    })
  })
})
