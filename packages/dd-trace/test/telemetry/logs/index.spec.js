'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
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
    let logs

    beforeEach(() => {
      telemetryLog = dc.channel('datadog:telemetry:log')
      errorLog = dc.channel('datadog:log:error:record')

      logCollectorAdd = sinon.stub()
      logs = proxyquire('../../../src/telemetry/logs', {
        './log-collector': {
          add: logCollectorAdd,
        },
      })
      logs.start(defaultConfig)
    })

    afterEach(() => logs.stop())

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

    describe('datadog:log:error:record', () => {
      it('should collect the cause of an error record', () => {
        const error = new Error('message')
        const stack = error.stack
        errorLog.publish({ cause: error, sendViaTelemetry: true })

        sinon.assert.calledOnceWithExactly(logCollectorAdd, match({
          message: 'Generic Error',
          level: 'ERROR',
          errorType: 'Error',
          stack_trace: stack,
        }))
      })

      it('should collect the message of an error record', () => {
        errorLog.publish({ message: 'custom error message', sendViaTelemetry: true })

        sinon.assert.calledOnceWithExactly(logCollectorAdd, match({
          message: 'custom error message',
          level: 'ERROR',
          stack_trace: undefined,
        }))
      })

      it('should ignore invalid error records', () => {
        errorLog.publish({ invalid: 'field', sendViaTelemetry: true })

        sinon.assert.notCalled(logCollectorAdd)
      })

      it('should ignore unresolved error records', () => {
        errorLog.publish(Log.parse(() => new Error('error')))

        sinon.assert.notCalled(logCollectorAdd)
      })

      it('should not be called when an error contains sendViaTelemetry:false', () => {
        errorLog.publish({ message: 'custom error message', sendViaTelemetry: false })

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

    afterEach(() => logs.stop())

    it('should send logs without implicit product metadata', () => {
      defaultConfig.isCiVisibility = true
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

    it('should retain the initial default tags until stopped', () => {
      logs.start(defaultConfig, { tags: 'component:initial' })
      logs.start(defaultConfig, { tags: 'component:replacement' })

      logs.send(defaultConfig, application, host)

      sinon.assert.calledOnceWithExactly(sendData, defaultConfig, application, host, 'logs', {
        logs: [{ message: 'message', level: 'ERROR', tags: 'component:initial' }],
      })
    })

    it('should clear default tags when restarted without options', () => {
      logs.start(defaultConfig, { tags: 'component:example' })
      logs.stop()
      logs.start(defaultConfig)

      logs.send(defaultConfig, application, host)

      sinon.assert.calledOnceWithExactly(sendData, defaultConfig, application, host, 'logs', { logs: collectedLogs })
    })

    it('should tag copies without mutating immutable collected logs', () => {
      collectedLogs = [
        Object.freeze({ message: 'frozen', level: 'ERROR' }),
        Object.seal({ message: 'sealed', level: 'WARN' }),
        Object.defineProperty({
          message: 'non-writable tags', level: 'ERROR', count: 2, tags: 'log_type:diagnostic',
        }, 'tags', { writable: false }),
      ]
      const originalLogs = collectedLogs.map(entry => ({ ...entry }))
      logCollectorDrain.returns(collectedLogs)
      logs.start(defaultConfig, { tags: 'component:example' })

      logs.send(defaultConfig, application, host)

      assert.deepStrictEqual(collectedLogs, originalLogs)
      sinon.assert.calledOnceWithExactly(sendData, defaultConfig, application, host, 'logs', {
        logs: [
          { message: 'frozen', level: 'ERROR', tags: 'component:example' },
          { message: 'sealed', level: 'WARN', tags: 'component:example' },
          {
            message: 'non-writable tags',
            level: 'ERROR',
            count: 2,
            tags: 'log_type:diagnostic,component:example',
          },
        ],
      })
    })

    it('should apply default tags while preserving existing tags', () => {
      collectedLogs.push({ message: 'AppSec diagnostic', level: 'WARN', tags: 'log_type:diagnostic' })
      logs.start(defaultConfig, { tags: 'component:example' })

      logs.send(defaultConfig, application, host)

      sinon.assert.calledOnceWithExactly(sendData, defaultConfig, application, host, 'logs', {
        logs: [
          { message: 'message', level: 'ERROR', tags: 'component:example' },
          {
            message: 'AppSec diagnostic',
            level: 'WARN',
            tags: 'log_type:diagnostic,component:example',
          },
        ],
      })
    })
  })
})
