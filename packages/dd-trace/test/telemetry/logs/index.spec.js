'use strict'

const t = require('tap')
require('../../setup/core')

const { match } = require('sinon')
const proxyquire = require('proxyquire')
const { Log } = require('../../../src/log/log')

t.test('telemetry logs', t => {
  let defaultConfig
  let telemetryLog
  let dc

  t.beforeEach(() => {
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

  t.test('start', t => {
    t.test('should be enabled by default and subscribe', t => {
      const logs = proxyquire('../../../src/telemetry/logs', {
        'dc-polyfill': dc
      })

      logs.start(defaultConfig)

      expect(telemetryLog.subscribe).to.have.been.calledTwice
      t.end()
    })

    t.test('should be subscribe only once', t => {
      const logs = proxyquire('../../../src/telemetry/logs', {
        'dc-polyfill': dc
      })

      logs.start(defaultConfig)
      logs.start(defaultConfig)
      logs.start(defaultConfig)

      expect(telemetryLog.subscribe).to.have.been.calledTwice
      t.end()
    })

    t.test('should be disabled and not subscribe if DD_TELEMETRY_LOG_COLLECTION_ENABLED = false', t => {
      const logs = proxyquire('../../../src/telemetry/logs', {
        'dc-polyfill': dc
      })

      defaultConfig.telemetry.logCollection = false
      logs.start(defaultConfig)

      expect(telemetryLog.subscribe).to.not.been.called
      t.end()
    })
    t.end()
  })

  t.test('stop', t => {
    t.test('should unsubscribe configured listeners', t => {
      const logs = proxyquire('../../../src/telemetry/logs', {
        'dc-polyfill': dc
      })
      logs.start(defaultConfig)

      logs.stop()

      expect(telemetryLog.unsubscribe).to.have.been.calledTwice
      t.end()
    })
    t.end()
  })

  t.test('logCollector add', t => {
    const dc = require('dc-polyfill')
    let logCollectorAdd
    let telemetryLog
    let errorLog

    t.beforeEach(() => {
      telemetryLog = dc.channel('datadog:telemetry:log')
      errorLog = dc.channel('datadog:log:error')

      logCollectorAdd = sinon.stub()
      const logs = proxyquire('../../../src/telemetry/logs', {
        './log-collector': {
          add: logCollectorAdd
        }
      })
      logs.start(defaultConfig)
    })

    t.test('should be not called with DEBUG level', t => {
      telemetryLog.publish({ message: 'message', level: 'DEBUG' })

      expect(logCollectorAdd).to.not.be.called
      t.end()
    })

    t.test('should be called with WARN level', t => {
      telemetryLog.publish({ message: 'message', level: 'WARN' })

      expect(logCollectorAdd).to.be.calledOnceWith(match({ message: 'message', level: 'WARN' }))
      t.end()
    })

    t.test('should be called with ERROR level', t => {
      telemetryLog.publish({ message: 'message', level: 'ERROR' })

      expect(logCollectorAdd).to.be.calledOnceWith(match({ message: 'message', level: 'ERROR' }))
      t.end()
    })

    t.test('should be called with ERROR level and stack_trace', t => {
      const error = new Error('message')
      const stack = error.stack
      telemetryLog.publish({ message: error.message, stack_trace: stack, level: 'ERROR' })

      expect(logCollectorAdd).to.be.calledOnceWith(match({ message: 'message', level: 'ERROR', stack_trace: stack }))
      t.end()
    })

    t.test('should not be called with no defined level', t => {
      telemetryLog.publish({ message: 'message' })

      expect(logCollectorAdd).to.not.be.called
      t.end()
    })

    t.test('should not be called with incorrect level', t => {
      telemetryLog.publish({ message: 'message', level: 'INFO' })

      expect(logCollectorAdd).to.not.be.called
      t.end()
    })

    t.test('datadog:log:error', t => {
      t.test('should be called when an Error object is published to datadog:log:error', t => {
        const error = new Error('message')
        const stack = error.stack
        errorLog.publish({ cause: error })

        expect(logCollectorAdd)
          .to.be.calledOnceWith(match({
            message: 'Generic Error',
            level: 'ERROR',
            errorType: 'Error',
            stack_trace: stack
          }))
        t.end()
      })

      t.test('should be called when an error string is published to datadog:log:error', t => {
        errorLog.publish({ message: 'custom error message' })

        expect(logCollectorAdd).to.be.calledOnceWith(match({
          message: 'custom error message',
          level: 'ERROR',
          stack_trace: undefined
        }))
        t.end()
      })

      t.test('should not be called when an invalid object is published to datadog:log:error', t => {
        errorLog.publish({ invalid: 'field' })

        expect(logCollectorAdd).not.to.be.called
        t.end()
      })

      t.test('should not be called when an object without message and stack is published to datadog:log:error', t => {
        errorLog.publish(Log.parse(() => new Error('error')))

        expect(logCollectorAdd).not.to.be.called
        t.end()
      })
      t.end()
    })
    t.end()
  })

  t.test('send', t => {
    let collectedLogs, application, host
    let logs
    let logCollectorDrain
    let sendData

    t.beforeEach(() => {
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

    t.test('should drain logCollector and call sendData', t => {
      logs.start(defaultConfig)

      logs.send(defaultConfig, application, host)

      expect(sendData).to.be.calledOnceWithExactly(defaultConfig, application, host, 'logs', { logs: collectedLogs })
      t.end()
    })

    t.test('should not drain logCollector and call sendData if not enabled', t => {
      defaultConfig.telemetry.logCollection = false

      logs.start(defaultConfig)

      logs.send(defaultConfig, application, host)

      expect(logCollectorDrain).to.not.be.called
      expect(sendData).to.not.be.called
      t.end()
    })
    t.end()
  })
  t.end()
})
