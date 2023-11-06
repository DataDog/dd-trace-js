'use strict'

require('../../setup/tap')

const { match } = require('sinon')
const proxyquire = require('proxyquire')

describe('telemetry logs', () => {
  let defaultConfig
  let telemetryLog
  let dc

  beforeEach(() => {
    defaultConfig = {
      telemetry: {
        enabled: true,
        logCollection: true,
        debug: false
      }
    }

    telemetryLog = {
      get hasSubscribers () {
        return this.subscribe.callCount > 0
      },
      subscribe: sinon.stub(),
      unsubscribe: sinon.stub()
    }

    dc = {
      channel: () => telemetryLog
    }
  })

  describe('start', () => {
    it('should be enabled by default and subscribe', () => {
      const logs = proxyquire('../../../src/telemetry/logs', {
        'dc-polyfill': dc
      })

      logs.start(defaultConfig)

      expect(telemetryLog.subscribe).to.have.been.calledOnce
    })

    it('should be subscribe only once', () => {
      const logs = proxyquire('../../../src/telemetry/logs', {
        'dc-polyfill': dc
      })

      logs.start(defaultConfig)
      logs.start(defaultConfig)
      logs.start(defaultConfig)

      expect(telemetryLog.subscribe).to.have.been.calledOnce
    })

    it('should be disabled and not subscribe if DD_TELEMETRY_LOG_COLLECTION_ENABLED = false', () => {
      const logs = proxyquire('../../../src/telemetry/logs', {
        'dc-polyfill': dc
      })

      defaultConfig.telemetry.logCollection = false
      logs.start(defaultConfig)

      expect(telemetryLog.subscribe).to.not.been.called
    })
  })

  describe('stop', () => {
    it('should unsubscribe configured listeners', () => {
      const logs = proxyquire('../../../src/telemetry/logs', {
        'dc-polyfill': dc
      })
      logs.start(defaultConfig)

      logs.stop()

      expect(telemetryLog.unsubscribe).to.have.been.calledOnce
    })
  })

  describe('logCollector add', () => {
    const dc = require('dc-polyfill')
    let logCollectorAdd
    let telemetryLog

    beforeEach(() => {
      telemetryLog = dc.channel('datadog:telemetry:log')

      logCollectorAdd = sinon.stub()
      const logs = proxyquire('../../../src/telemetry/logs', {
        './log-collector': {
          add: logCollectorAdd
        }
      })
      logs.start(defaultConfig)
    })

    it('should be not called with DEBUG level', () => {
      telemetryLog.publish({ message: 'message', level: 'DEBUG' })

      expect(logCollectorAdd).to.not.be.called
    })

    it('should be called with WARN level', () => {
      telemetryLog.publish({ message: 'message', level: 'WARN' })

      expect(logCollectorAdd).to.be.calledOnceWith(match({ message: 'message', level: 'WARN' }))
    })

    it('should be called with ERROR level', () => {
      telemetryLog.publish({ message: 'message', level: 'ERROR' })

      expect(logCollectorAdd).to.be.calledOnceWith(match({ message: 'message', level: 'ERROR' }))
    })

    it('should be called with ERROR level and stack_trace', () => {
      const error = new Error('message')
      const stack = error.stack
      telemetryLog.publish({ message: error.message, stack_trace: stack, level: 'ERROR' })

      expect(logCollectorAdd).to.be.calledOnceWith(match({ message: 'message', level: 'ERROR', stack_trace: stack }))
    })

    it('should not be called with no defined level', () => {
      telemetryLog.publish({ message: 'message' })

      expect(logCollectorAdd).to.not.be.called
    })

    it('should not be called with incorrect level', () => {
      telemetryLog.publish({ message: 'message', level: 'INFO' })

      expect(logCollectorAdd).to.not.be.called
    })
  })

  describe('send', () => {
    let collectedLogs, application, host
    let logs
    let logCollectorDrain
    let sendData

    beforeEach(() => {
      collectedLogs = [{ message: 'message', level: 'ERROR' }]
      application = {}
      host = {}

      logCollectorDrain = sinon.stub().returns(collectedLogs)
      sendData = sinon.stub()

      logs = proxyquire('../../../src/telemetry/logs', {
        './log-collector': {
          drain: logCollectorDrain
        },
        '../send-data': {
          sendData
        }
      })
    })

    it('should drain logCollector and call sendData', () => {
      logs.start(defaultConfig)

      logs.send(defaultConfig, application, host)

      expect(sendData).to.be.calledOnceWithExactly(defaultConfig, application, host, 'logs', collectedLogs)
    })

    it('should not drain logCollector and call sendData if not enabled', () => {
      defaultConfig.telemetry.logCollection = false

      logs.start(defaultConfig)

      logs.send(defaultConfig, application, host)

      expect(logCollectorDrain).to.not.be.called
      expect(sendData).to.not.be.called
    })
  })
})
