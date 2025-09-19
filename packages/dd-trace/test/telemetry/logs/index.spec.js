'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { match } = sinon

require('../../setup/core')

const { Log } = require('../../../src/log/log')

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

      expect(telemetryLog.subscribe).to.have.been.calledTwice
    })

    it('should be subscribe only once', () => {
      const logs = proxyquire('../../../src/telemetry/logs', {
        'dc-polyfill': dc
      })

      logs.start(defaultConfig)
      logs.start(defaultConfig)
      logs.start(defaultConfig)

      expect(telemetryLog.subscribe).to.have.been.calledTwice
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

      expect(telemetryLog.unsubscribe).to.have.been.calledTwice
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

    describe('datadog:log:error', () => {
      it('should be called when an Error object is published to datadog:log:error', () => {
        const error = new Error('message')
        const stack = error.stack
        errorLog.publish({ cause: error, sendViaTelemetry: true })

        expect(logCollectorAdd)
          .to.be.calledOnceWith(match({
            message: 'Generic Error',
            level: 'ERROR',
            errorType: 'Error',
            stack_trace: stack
          }))
      })

      it('should be called when an error string is published to datadog:log:error', () => {
        errorLog.publish({ message: 'custom error message', sendViaTelemetry: true })

        expect(logCollectorAdd).to.be.calledOnceWith(match({
          message: 'custom error message',
          level: 'ERROR',
          stack_trace: undefined
        }))
      })

      it('should not be called when an invalid object is published to datadog:log:error', () => {
        errorLog.publish({ invalid: 'field', sendViaTelemetry: true })

        expect(logCollectorAdd).not.to.be.called
      })

      it('should not be called when an object without message and stack is published to datadog:log:error', () => {
        errorLog.publish(Log.parse(() => new Error('error')))

        expect(logCollectorAdd).not.to.be.called
      })

      it('should not be called when an error contains sendViaTelemetry:false', () => {
        errorLog.publish({ message: 'custom error message', sendViaTelemetry: false })

        expect(logCollectorAdd).not.to.be.called
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

      expect(sendData).to.be.calledOnceWithExactly(defaultConfig, application, host, 'logs', { logs: collectedLogs })
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
