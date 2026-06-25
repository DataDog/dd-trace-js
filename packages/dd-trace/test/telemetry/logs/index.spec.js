'use strict'

const { describe, it, beforeEach, afterEach } = require('mocha')
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
        enabled: true,
        logCollection: true,
        debug: false,
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

      defaultConfig.telemetry.logCollection = false
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
      it('should be called when cause has a reported error code', () => {
        const error = new Error('message')
        error.code = 'DD_TRACER_INIT_ERROR'
        const stack = error.stack
        errorLog.publish({ message: 'something failed', cause: error })

        sinon.assert.calledOnceWithExactly(logCollectorAdd, match({
          message: 'something failed',
          level: 'ERROR',
          errorType: 'Error',
          stack_trace: stack,
        }))
      })

      it('should not be called when cause has no code', () => {
        const error = new Error('message')
        errorLog.publish({ message: 'something failed', cause: error })

        sinon.assert.notCalled(logCollectorAdd)
      })

      it('should not be called when there is no cause', () => {
        errorLog.publish({ message: 'custom error message' })

        sinon.assert.notCalled(logCollectorAdd)
      })

      it('should not be called when cause has an unreported DD_ code', () => {
        const error = new Error('message')
        error.code = 'DD_SOME_FUTURE_CODE'
        errorLog.publish({ cause: error })

        sinon.assert.notCalled(logCollectorAdd)
      })

      it('should not be called when cause has a non-DD_ code', () => {
        const error = new Error('network error')
        error.code = 'ECONNREFUSED'
        errorLog.publish({ cause: error })

        sinon.assert.notCalled(logCollectorAdd)
      })
    })

    describe('log module integration', () => {
      let log
      let logCollectorAdd

      beforeEach(() => {
        logCollectorAdd = sinon.stub()
        const logs = proxyquire('../../../src/telemetry/logs', {
          './log-collector': { add: logCollectorAdd },
        })
        logs.start(defaultConfig)
        log = require('../../../src/log')
        log.configure({ logger: { error: () => {}, warn: () => {}, debug: () => {} } })
      })

      afterEach(() => {
        log.configure({})
      })

      it('should report errors from log.error when cause has a DD_ code', () => {
        const cause = new Error('the cause')
        cause.code = 'DD_TRACER_INIT_ERROR'

        log.error('something broke', cause)

        sinon.assert.calledOnce(logCollectorAdd)
        sinon.assert.calledWith(logCollectorAdd, match({
          message: 'something broke',
          level: 'ERROR',
          stack_trace: cause.stack,
          errorType: 'Error',
        }))
      })

      it('should report errors from log.error(error) when error has a DD_ code', () => {
        const cause = new Error('the cause')
        cause.code = 'DD_TRACER_INIT_ERROR'

        log.error(cause)

        sinon.assert.calledOnce(logCollectorAdd)
        sinon.assert.calledWith(logCollectorAdd, match({
          level: 'ERROR',
          stack_trace: cause.stack,
          errorType: 'Error',
        }))
      })

      it('should not report errors from log.error when cause has no DD_ code', () => {
        log.error('something broke', new Error('plain error'))

        sinon.assert.notCalled(logCollectorAdd)
      })

      it('should not report errors from log.error when cause has a non-DD_ code', () => {
        const cause = new Error('network error')
        cause.code = 'ECONNREFUSED'

        log.error('sending failed', cause)

        sinon.assert.notCalled(logCollectorAdd)
      })

      it('should not report errors from log.error with no cause', () => {
        log.error('plain message with no error')

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
      defaultConfig.telemetry.logCollection = false

      logs.start(defaultConfig)

      logs.send(defaultConfig, application, host)

      sinon.assert.notCalled(logCollectorDrain)
      sinon.assert.notCalled(sendData)
    })
  })
})
