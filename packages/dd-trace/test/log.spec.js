'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('./setup/core')
const { storage } = require('../../datadog-core')

/* eslint-disable no-console */

describe('log', () => {
  describe('config', () => {
    let env

    /**
     * @param {{
     *   fleetEntries?: Record<string, string|undefined>,
     *   localEntries?: Record<string, string|undefined>,
     *   isServerless?: boolean
     * }} [options]
     */
    const reloadLog = (options = {}) => {
      const { fleetEntries, localEntries, isServerless = true } = options
      const logWriter = {
        configure: sinon.spy(),
      }
      const configHelper = isServerless
        ? proxyquire.noPreserveCache()('../src/config/helper', {
          '../serverless': { IS_SERVERLESS: true },
        })
        : proxyquire.noPreserveCache()('../src/config/helper', {
          '../serverless': { IS_SERVERLESS: false },
          './stable': function StableConfigStub () {
            this.localEntries = localEntries
            this.fleetEntries = fleetEntries
            this.warnings = []
          },
        })

      const log = proxyquire.noPreserveCache()('../src/log', {
        '../config/helper': configHelper,
        './writer': logWriter,
      })

      logWriter.configure.resetHistory()

      return { log, logWriter }
    }

    beforeEach(() => {
      env = process.env
      process.env = {}
    })

    afterEach(() => {
      process.env = env
    })

    it('should have configure function', () => {
      const { log } = reloadLog()
      assert.strictEqual(typeof log.configure, 'function')
    })

    it('should configure with default config if no environment variables are set', () => {
      const { log, logWriter } = reloadLog()

      assert.strictEqual(log.configure({}), false)
      sinon.assert.calledOnceWithExactly(logWriter.configure, false, 'debug', undefined)
    })

    it('should pass the logger option to the writer', () => {
      const { log, logWriter } = reloadLog()
      const logger = {
        debug: () => {},
        error: () => {},
      }

      log.configure({ logger })

      sinon.assert.calledOnceWithExactly(logWriter.configure, false, 'debug', logger)
    })

    it('should initialize from environment variables with DD env vars taking precedence OTEL env vars', () => {
      process.env.DD_TRACE_LOG_LEVEL = 'error'
      process.env.DD_TRACE_DEBUG = 'false'
      process.env.OTEL_LOG_LEVEL = 'debug'
      const { log, logWriter } = reloadLog()

      assert.strictEqual(log.configure({}), false)
      sinon.assert.calledOnceWithExactly(logWriter.configure, false, 'error', undefined)
    })

    it('should initialize with OTEL environment variables when DD env vars are not set', () => {
      process.env.OTEL_LOG_LEVEL = 'debug'
      const { log, logWriter } = reloadLog()

      assert.strictEqual(log.configure({}), true)
      sinon.assert.calledOnceWithExactly(logWriter.configure, true, 'debug', undefined)
    })

    it('should initialize from environment variables', () => {
      process.env.DD_TRACE_DEBUG = 'true'
      const { log, logWriter } = reloadLog()

      assert.strictEqual(log.configure({}), true)
      sinon.assert.calledOnceWithExactly(logWriter.configure, true, 'debug', undefined)
    })

    it('should read case-insensitive booleans from environment variables', () => {
      process.env.DD_TRACE_DEBUG = 'TRUE'
      const { log, logWriter } = reloadLog()

      assert.strictEqual(log.configure({}), true)
      sinon.assert.calledOnceWithExactly(logWriter.configure, true, 'debug', undefined)
    })

    describe('configure', () => {
      it('prefers fleetStableConfigValue over env and local', () => {
        process.env.DD_TRACE_DEBUG = 'false'

        let loaded = reloadLog({
          fleetEntries: { DD_TRACE_DEBUG: 'true' },
          isServerless: false,
          localEntries: { DD_TRACE_DEBUG: 'false' },
        })
        assert.strictEqual(loaded.log.configure({}), true)

        process.env.DD_TRACE_DEBUG = 'true'

        loaded = reloadLog({
          fleetEntries: { DD_TRACE_DEBUG: 'false' },
          isServerless: false,
          localEntries: { DD_TRACE_DEBUG: 'true' },
        })
        assert.strictEqual(loaded.log.configure({}), false)
      })

      it('uses DD_TRACE_DEBUG when fleetStableConfigValue is not set', () => {
        process.env.DD_TRACE_DEBUG = 'true'
        let loaded = reloadLog({
          isServerless: false,
          localEntries: { DD_TRACE_DEBUG: 'false' },
        })
        assert.strictEqual(loaded.log.configure({}), true)

        process.env.DD_TRACE_DEBUG = 'false'
        loaded = reloadLog({
          isServerless: false,
          localEntries: { DD_TRACE_DEBUG: 'true' },
        })
        assert.strictEqual(loaded.log.configure({}), false)
      })

      it('uses OTEL_LOG_LEVEL=debug when DD vars are not set', () => {
        process.env.OTEL_LOG_LEVEL = 'debug'
        let loaded = reloadLog({
          isServerless: false,
          localEntries: { OTEL_LOG_LEVEL: 'info' },
        })
        assert.strictEqual(loaded.log.configure({}), true)

        process.env.OTEL_LOG_LEVEL = 'info'
        loaded = reloadLog({
          isServerless: false,
          localEntries: { OTEL_LOG_LEVEL: 'debug' },
        })
        assert.strictEqual(loaded.log.configure({}), false)
      })

      it('falls back to localStableConfigValue', () => {
        let loaded = reloadLog({
          isServerless: false,
          localEntries: { DD_TRACE_DEBUG: 'false' },
        })
        assert.strictEqual(loaded.log.configure({}), false)

        loaded = reloadLog({
          isServerless: false,
          localEntries: { DD_TRACE_DEBUG: 'true' },
        })
        assert.strictEqual(loaded.log.configure({}), true)
      })

      it('falls back to internal config.enabled when nothing else provided', () => {
        const { log, logWriter } = reloadLog({
          fleetEntries: {},
          isServerless: false,
          localEntries: {},
        })

        process.env.OTEL_LOG_LEVEL = 'debug'
        assert.strictEqual(log.configure({}), true)

        process.env = {}
        assert.strictEqual(log.configure({}), true)
        sinon.assert.calledWithExactly(logWriter.configure.secondCall, true, 'debug', undefined)
      })

      it('falls back to the previous log level when no override is provided', () => {
        const { log, logWriter } = reloadLog()

        log.configure({ logLevel: 'error' })
        log.configure({})

        sinon.assert.calledWithExactly(logWriter.configure.secondCall, false, 'error', undefined)
      })
    })
  })

  describe('general usage', () => {
    let env
    let log
    let logger
    let error

    function loadConfiguredLog (options = {}, envEntries = {}) {
      process.env = {
        DD_TRACE_DEBUG: 'true',
        ...envEntries,
      }
      log = proxyquire.noPreserveCache()('../src/log', {})
      log.configure(options)
      return log
    }

    beforeEach(() => {
      env = process.env
      process.env = {}
      sinon.stub(console, 'info')
      sinon.stub(console, 'error')
      sinon.stub(console, 'warn')
      sinon.stub(console, 'debug')

      error = new Error()

      logger = {
        debug: sinon.spy(),
        error: sinon.spy(),
      }

      loadConfiguredLog()
    })

    afterEach(() => {
      process.env = env
      console.info.restore()
      console.error.restore()
      console.warn.restore()
      console.debug.restore()
    })

    it('should support chaining', () => {
      loadConfiguredLog({ logger })

      log
        .error('error')
        .debug('debug')
    })

    it('should call the logger in a noop context', () => {
      logger.debug = () => {
        assert.ok('noop' in storage('legacy').getStore())
        assert.strictEqual(storage('legacy').getStore().noop, true)
      }

      loadConfiguredLog({ logger })
      log.debug('debug')
    })

    describe('debug', () => {
      it('should log to console by default', () => {
        log.debug('debug')

        sinon.assert.calledWith(console.debug, 'debug')
      })

      it('should support callbacks that return a message', () => {
        log.debug(() => 'debug')

        sinon.assert.calledWith(console.debug, 'debug')
      })
    })

    describe('trace', () => {
      it('should not log to console by default', () => {
        log.trace('trace')

        sinon.assert.notCalled(console.debug)
      })

      it('should log to console after setting log level to trace', function foo () {
        class Foo {
          constructor () {
            this.bar = 'baz'
          }
        }

        loadConfiguredLog({ logLevel: 'trace' })
        log.trace('argument', { hello: 'world' }, new Foo())

        sinon.assert.calledOnce(console.debug)
        assert.match(console.debug.firstCall.args[0],
          /^Trace: Context.foo\('argument', { hello: 'world' }, Foo { bar: 'baz' }\)/
        )
        assert.ok(console.debug.firstCall.args[0].split('\n').length >= 3)
      })
    })

    describe('error', () => {
      it('should log to console by default', () => {
        log.error(error)

        sinon.assert.calledWith(console.error, error)
      })

      it('should support callbacks that return a error', () => {
        log.error(() => error)

        sinon.assert.calledWith(console.error, error)
      })

      it('should convert strings to errors', () => {
        log.error('error')

        sinon.assert.called(console.error)
        assert.ok(console.error.firstCall.args[0] instanceof Error)
        assert.strictEqual(console.error.firstCall.args[0].message, 'error')
      })

      // NOTE: There is no usage for this case. should we continue supporting it?
      it('should convert empty values to errors', () => {
        log.error()

        sinon.assert.called(console.error)
        assert.ok(console.error.firstCall.args[0] instanceof Error)
        assert.strictEqual(console.error.firstCall.args[0].message, 'undefined')
      })

      it('should convert invalid types to errors', () => {
        log.error(123)

        sinon.assert.called(console.error)
        assert.ok(console.error.firstCall.args[0] instanceof Error)
        assert.strictEqual(console.error.firstCall.args[0].message, '123')
      })

      it('should reuse error messages for non-errors', () => {
        log.error({ message: 'test' })

        sinon.assert.called(console.error)
        assert.ok(console.error.firstCall.args[0] instanceof Error)
        assert.strictEqual(console.error.firstCall.args[0].message, 'test')
      })

      it('should convert messages from callbacks to errors', () => {
        log.error(() => 'error')

        sinon.assert.called(console.error)
        assert.ok(console.error.firstCall.args[0] instanceof Error)
        assert.strictEqual(console.error.firstCall.args[0].message, 'error')
      })

      it('should allow a message + Error', () => {
        log.error('this is an error', new Error('cause'))

        sinon.assert.called(console.error)
        assert.ok(console.error.firstCall.args[0] instanceof Error)
        assert.strictEqual(console.error.firstCall.args[0].message, 'this is an error')
        assert.ok(console.error.secondCall.args[0] instanceof Error)
        assert.strictEqual(console.error.secondCall.args[0].message, 'cause')
      })

      it('should allow a templated message', () => {
        log.error('this is an error of type: %s code: %i', 'ERR', 42)

        sinon.assert.called(console.error)
        assert.ok(console.error.firstCall.args[0] instanceof Error)
        assert.strictEqual(console.error.firstCall.args[0].message, 'this is an error of type: ERR code: 42')
      })

      it('should allow a templated message + Error', () => {
        log.error('this is an error of type: %s code: %i', 'ERR', 42, new Error('cause'))

        sinon.assert.called(console.error)
        assert.ok(console.error.firstCall.args[0] instanceof Error)
        assert.strictEqual(console.error.firstCall.args[0].message, 'this is an error of type: ERR code: 42')
        assert.ok(console.error.secondCall.args[0] instanceof Error)
        assert.strictEqual(console.error.secondCall.args[0].message, 'cause')
      })

      it('should allow a message + Error + LogConfig', () => {
        log.error('this is an error with a log config', log.NO_TRANSMIT)

        sinon.assert.called(console.error)
        assert.ok(console.error.firstCall.args[0] instanceof Error)
        assert.strictEqual(console.error.firstCall.args[0].message, 'this is an error with a log config')
      })

      it('should allow a message + NoTransmitError', () => {
        log.error('this is an error without a log config', new log.NoTransmitError('bad underlying thing'))

        sinon.assert.called(console.error)
        assert.ok(console.error.firstCall.args[0] instanceof Error)
        assert.strictEqual(console.error.firstCall.args[0].message, 'this is an error without a log config')
        assert.ok(console.error.secondCall.args[0] instanceof Error)
        assert.strictEqual(console.error.secondCall.args[0].message, 'bad underlying thing')
      })
    })

    describe('configure', () => {
      it('should disable the logger when DD_TRACE_DEBUG is false', () => {
        loadConfiguredLog({}, { DD_TRACE_DEBUG: 'false' })
        log.debug('debug')
        log.error(error)

        sinon.assert.notCalled(console.debug)
        sinon.assert.notCalled(console.error)
      })

      it('should enable the logger when OTEL_LOG_LEVEL is debug', () => {
        loadConfiguredLog({}, { OTEL_LOG_LEVEL: 'debug' })
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(console.debug, 'debug')
        sinon.assert.calledWith(console.error, error)
      })

      it('should set minimum log level when configured with a valid string', () => {
        loadConfiguredLog({ logLevel: 'error' })
        log.debug('debug')
        log.error(error)

        sinon.assert.notCalled(console.debug)
        sinon.assert.calledWith(console.error, error)
      })

      it('should set default log level when configured with an invalid string', () => {
        loadConfiguredLog({ logLevel: 'not a real log level' })
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(console.debug, 'debug')
        sinon.assert.calledWith(console.error, error)
      })

      it('should set min log level when configured with valid string with wrong case or whitespace', () => {
        loadConfiguredLog({ logLevel: ' ErRoR   ' })
        log.debug('debug')
        log.error(error)

        sinon.assert.notCalled(console.debug)
        sinon.assert.calledWith(console.error, error)
      })

      it('should log all log levels greater than or equal to minimum log level', () => {
        loadConfiguredLog({ logLevel: 'debug' })
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(console.debug, 'debug')
        sinon.assert.calledWith(console.error, error)
      })

      it('should enable default log level when configured with invalid input', () => {
        loadConfiguredLog({ logLevel: ['trace', 'info', 'eror'] })
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(console.debug, 'debug')
        sinon.assert.calledWith(console.error, error)
      })

      it('should enable default log level when configured without logLevel argument', () => {
        loadConfiguredLog()
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(console.debug, 'debug')
        sinon.assert.calledWith(console.error, error)
      })
    })

    describe('logger option', () => {
      it('should set the underlying logger when valid', () => {
        loadConfiguredLog({ logger })
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(logger.debug, 'debug')
        sinon.assert.calledWith(logger.error, error)
      })

      it('be a no op with an empty logger', () => {
        loadConfiguredLog({ logger: null })
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(console.debug, 'debug')
        sinon.assert.calledWith(console.error, error)
      })

      it('be a no op with an invalid logger', () => {
        loadConfiguredLog({ logger: 'invalid' })
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(console.debug, 'debug')
        sinon.assert.calledWith(console.error, error)
      })
    })

    describe('deprecate', () => {
      it('should log a deprecation warning', () => {
        log.deprecate('test', 'message')

        sinon.assert.calledOnce(console.error)
        const consoleErrorArg = console.error.getCall(0).args[0]
        assert.strictEqual(typeof consoleErrorArg, 'string')
        assert.strictEqual(consoleErrorArg, 'message')
      })

      it('should only log once for a given code', () => {
        log.deprecate('test', 'message')
        log.deprecate('test', 'message')

        sinon.assert.calledOnce(console.error)
      })
    })

    describe('logWriter', () => {
      let logWriter

      beforeEach(() => {
        logWriter = proxyquire.noPreserveCache()('../src/log/writer', {})
      })

      describe('error', () => {
        it('should call logger error', () => {
          logWriter.error(error)

          sinon.assert.calledOnceWithExactly(console.error, error)
        })

        it('should call console.error no matter enable flag value', () => {
          logWriter.configure(false)
          logWriter.error(error)

          sinon.assert.calledOnceWithExactly(console.error, error)
        })
      })

      describe('warn', () => {
        it('should call logger warn', () => {
          logWriter.warn('warn')

          sinon.assert.calledOnceWithExactly(console.warn, 'warn')
        })

        it('should call logger debug if warn is not provided', () => {
          logWriter.configure(false, undefined, logger)
          logWriter.warn('warn')

          sinon.assert.calledOnceWithExactly(logger.debug, 'warn')
        })

        it('should call console.warn no matter enable flag value', () => {
          logWriter.configure(false)
          logWriter.warn('warn')

          sinon.assert.calledOnceWithExactly(console.warn, 'warn')
        })
      })

      describe('info', () => {
        it('should call logger info', () => {
          logWriter.info('info')

          sinon.assert.calledOnceWithExactly(console.info, 'info')
        })

        it('should call logger debug if info is not provided', () => {
          logWriter.configure(false, undefined, logger)
          logWriter.info('info')

          sinon.assert.calledOnceWithExactly(logger.debug, 'info')
        })

        it('should call console.info no matter enable flag value', () => {
          logWriter.configure(false)
          logWriter.info('info')

          sinon.assert.calledOnceWithExactly(console.info, 'info')
        })
      })

      describe('debug', () => {
        it('should call logger debug', () => {
          logWriter.debug('debug')

          sinon.assert.calledOnceWithExactly(console.debug, 'debug')
        })

        it('should call console.debug no matter enable flag value', () => {
          logWriter.configure(false)
          logWriter.debug('debug')

          sinon.assert.calledOnceWithExactly(console.debug, 'debug')
        })
      })
    })
  })
})
