'use strict'

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { match } = sinon

require('../../setup/core')

describe('telemetry logs', () => {
  let defaultConfig
  let telemetryLog
  let dc

  beforeEach(() => {
    defaultConfig = {
      telemetry: {
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: true,
        DD_TELEMETRY_LOG_COLLECTION_ENABLED: true,
        DD_TELEMETRY_DEBUG: false,
      },
    }

    telemetryLog = {
      get hasSubscribers () {
        return this.subscribe.callCount > 0
      },
      subscribe: sinon.stub(),
      unsubscribe: sinon.stub(),
    }

    dc = {
      channel: () => telemetryLog,
    }
  })

  describe('start', () => {
    it('should be enabled by default and subscribe', () => {
      const logs = proxyquire('../../../src/telemetry/logs', {
        'dc-polyfill': dc,
      })

      logs.start(defaultConfig)

      sinon.assert.calledTwice(telemetryLog.subscribe)
    })

    it('should be subscribe only once', () => {
      const logs = proxyquire('../../../src/telemetry/logs', {
        'dc-polyfill': dc,
      })

      logs.start(defaultConfig)
      logs.start(defaultConfig)
      logs.start(defaultConfig)

      sinon.assert.calledTwice(telemetryLog.subscribe)
    })

    it('should be disabled and not subscribe if DD_TELEMETRY_LOG_COLLECTION_ENABLED = false', () => {
      const logs = proxyquire('../../../src/telemetry/logs', {
        'dc-polyfill': dc,
      })

      defaultConfig.telemetry.DD_TELEMETRY_LOG_COLLECTION_ENABLED = false
      logs.start(defaultConfig)

      sinon.assert.notCalled(telemetryLog.subscribe)
    })
  })

  describe('stop', () => {
    it('should unsubscribe configured listeners', () => {
      const logs = proxyquire('../../../src/telemetry/logs', {
        'dc-polyfill': dc,
      })
      logs.start(defaultConfig)

      logs.stop()

      sinon.assert.calledTwice(telemetryLog.unsubscribe)
    })
  })

  describe('logCollector add', () => {
    const dc = require('dc-polyfill')
    let logCollectorAdd
    let telemetryLog
    let errorLog

    beforeEach(() => {
      telemetryLog = dc.channel('datadog:telemetry:log')
      errorLog = dc.channel('datadog:log:error')

      logCollectorAdd = sinon.stub()
      const logs = proxyquire('../../../src/telemetry/logs', {
        './log-collector': {
          add: logCollectorAdd,
        },
      })
      logs.start(defaultConfig)
    })

    it('should be not called with DEBUG level', () => {
      telemetryLog.publish({ message: 'message', level: 'DEBUG' })

      sinon.assert.notCalled(logCollectorAdd)
    })

    it('should be called with WARN level', () => {
      telemetryLog.publish({ message: 'message', level: 'WARN' })

      sinon.assert.calledOnceWithExactly(logCollectorAdd, match({ message: 'message', level: 'WARN' }))
    })

    it('should be called with ERROR level', () => {
      telemetryLog.publish({ message: 'message', level: 'ERROR' })

      sinon.assert.calledOnceWithExactly(logCollectorAdd, match({ message: 'message', level: 'ERROR' }))
    })

    it('should be called with ERROR level and stack_trace', () => {
      const error = new Error('message')
      const stack = error.stack
      telemetryLog.publish({ message: error.message, stack_trace: stack, level: 'ERROR' })

      sinon.assert.calledOnceWithExactly(
        logCollectorAdd,
        match({ message: 'message', level: 'ERROR', stack_trace: stack })
      )
    })

    it('should not be called with no defined level', () => {
      telemetryLog.publish({ message: 'message' })

      sinon.assert.notCalled(logCollectorAdd)
    })

    it('should not be called with incorrect level', () => {
      telemetryLog.publish({ message: 'message', level: 'INFO' })

      sinon.assert.notCalled(logCollectorAdd)
    })

    describe('datadog:log:error', () => {
      it('should be called when an Error object is published to datadog:log:error', () => {
        const error = new Error('message')
        const stack = error.stack
        errorLog.publish(error)

        sinon.assert.calledOnceWithExactly(logCollectorAdd, match({
          message: 'message',
          level: 'ERROR',
          errorType: 'Error',
          stack_trace: stack,
        }))
      })

      it('should use the outer message and the cause stack', () => {
        const cause = new Error('cause')
        const error = new Error('custom error message', { cause })
        errorLog.publish(error)

        sinon.assert.calledOnceWithExactly(logCollectorAdd, match({
          message: 'custom error message',
          level: 'ERROR',
          stack_trace: cause.stack,
        }))
      })

      it('should not be called when an invalid object is published to datadog:log:error', () => {
        errorLog.publish()

        sinon.assert.notCalled(logCollectorAdd)
      })

      it('should not be called when an error contains sendViaTelemetry:false', () => {
        const error = new Error('custom error message')
        error.sendViaTelemetry = false
        errorLog.publish(error)

        sinon.assert.notCalled(logCollectorAdd)
      })

      it('should collect an actual log.error call once', () => {
        const cause = new Error('cause')
        const log = require('../../../src/log')

        log.error('custom error message', cause)

        sinon.assert.calledOnceWithExactly(logCollectorAdd, match({
          message: 'custom error message',
          level: 'ERROR',
          errorType: 'Error',
          stack_trace: cause.stack,
        }))
      })

      it('should not collect an actual log.errorWithoutTelemetry call', () => {
        const log = require('../../../src/log')

        log.errorWithoutTelemetry('custom error message', new Error('cause'))

        sinon.assert.notCalled(logCollectorAdd)
      })
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
          drain: logCollectorDrain,
        },
        '../send-data': {
          sendData,
        },
      })
    })

    it('should drain logCollector and call sendData', () => {
      logs.start(defaultConfig)

      logs.send(defaultConfig, application, host)

      sinon.assert.calledOnceWithExactly(sendData, defaultConfig, application, host, 'logs', { logs: collectedLogs })
    })

    it('should not drain logCollector and call sendData if not enabled', () => {
      defaultConfig.telemetry.DD_TELEMETRY_LOG_COLLECTION_ENABLED = false

      logs.start(defaultConfig)

      logs.send(defaultConfig, application, host)

      sinon.assert.notCalled(logCollectorDrain)
      sinon.assert.notCalled(sendData)
    })
  })
})
