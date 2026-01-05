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

    beforeEach(() => {
      env = process.env
      process.env = {}
    })

    afterEach(() => {
      process.env = env
    })

    it('should have getConfig function', () => {
      const log = require('../src/log')
      assert.strictEqual(typeof log.getConfig, 'function')
    })

    it('should be configured with default config if no environment variables are set', () => {
      const log = require('../src/log')
      assert.deepStrictEqual(log.getConfig(), {
        enabled: false,
        logger: undefined,
        logLevel: 'debug'
      })
    })

    it('should not be possbile to mutate config object returned by getConfig', () => {
      const log = require('../src/log')
      const config = log.getConfig()
      config.enabled = 1
      config.logger = 1
      config.logLevel = 1
      assert.deepStrictEqual(log.getConfig(), {
        enabled: false,
        logger: undefined,
        logLevel: 'debug'
      })
    })

    it('should initialize from environment variables with DD env vars taking precedence OTEL env vars', () => {
      process.env.DD_TRACE_LOG_LEVEL = 'error'
      process.env.DD_TRACE_DEBUG = 'false'
      process.env.OTEL_LOG_LEVEL = 'debug'
      const config = proxyquire('../src/log', {}).getConfig()
      assert.strictEqual(config.enabled, false)
      assert.strictEqual(config.logLevel, 'error')
    })

    it('should initialize with OTEL environment variables when DD env vars are not set', () => {
      process.env.OTEL_LOG_LEVEL = 'debug'
      const config = proxyquire('../src/log', {}).getConfig()
      assert.strictEqual(config.enabled, true)
      assert.strictEqual(config.logLevel, 'debug')
    })

    it('should initialize from environment variables', () => {
      process.env.DD_TRACE_DEBUG = 'true'
      const config = proxyquire('../src/log', {}).getConfig()
      assert.strictEqual(config.enabled, true)
    })

    it('should read case-insensitive booleans from environment variables', () => {
      process.env.DD_TRACE_DEBUG = 'TRUE'
      const config = proxyquire('../src/log', {}).getConfig()
      assert.strictEqual(config.enabled, true)
    })

    describe('isEnabled', () => {
      it('prefers fleetStableConfigValue over env and local', () => {
        const log = proxyquire('../src/log', {})
        assert.strictEqual(log.isEnabled('true', 'false'), true)
        assert.strictEqual(log.isEnabled('false', 'true'), false)
      })

      it('uses DD_TRACE_DEBUG when fleetStableConfigValue is not set', () => {
        process.env.DD_TRACE_DEBUG = 'true'
        let log = proxyquire('../src/log', {})
        assert.strictEqual(log.isEnabled(undefined, 'false'), true)

        process.env.DD_TRACE_DEBUG = 'false'
        log = proxyquire('../src/log', {})
        assert.strictEqual(log.isEnabled(undefined, 'true'), false)
      })

      it('uses OTEL_LOG_LEVEL=debug when DD vars are not set', () => {
        process.env.OTEL_LOG_LEVEL = 'debug'
        let log = proxyquire('../src/log', {})
        assert.strictEqual(log.isEnabled(undefined, undefined), true)

        process.env.OTEL_LOG_LEVEL = 'info'
        log = proxyquire('../src/log', {})
        assert.strictEqual(log.isEnabled(undefined, undefined), false)
      })

      it('falls back to localStableConfigValue', () => {
        const log = proxyquire('../src/log', {})
        assert.strictEqual(log.isEnabled(undefined, 'false'), false)
        assert.strictEqual(log.isEnabled(undefined, 'true'), true)
      })

      it('falls back to internal config.enabled when nothing else provided', () => {
        const log = proxyquire('../src/log', {})
        log.toggle(true)
        assert.strictEqual(log.isEnabled(), true)
        log.toggle(false)
        assert.strictEqual(log.isEnabled(), false)
      })
    })
  })

  describe('general usage', () => {
    let log
    let logger
    let error

    beforeEach(() => {
      sinon.stub(console, 'info')
      sinon.stub(console, 'error')
      sinon.stub(console, 'warn')
      sinon.stub(console, 'debug')

      error = new Error()

      logger = {
        debug: sinon.spy(),
        error: sinon.spy()
      }

      log = proxyquire('../src/log', {})
      log.toggle(true)
    })

    afterEach(() => {
      log.reset()
      console.info.restore()
      console.error.restore()
      console.warn.restore()
      console.debug.restore()
    })

    it('should support chaining', () => {
      assert.doesNotThrow(() => {
        log
          .use(logger)
          .toggle(true)
          .error('error')
          .debug('debug')
          .reset()
      })
    })

    it('should call the logger in a noop context', () => {
      logger.debug = () => {
        assert.ok('noop' in storage('legacy').getStore())
        assert.strictEqual(storage('legacy').getStore().noop, true)
      }

      log.use(logger).debug('debug')
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

        log.toggle(true, 'trace')
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

    describe('toggle', () => {
      it('should disable the logger', () => {
        log.toggle(false)
        log.debug('debug')
        log.error(error)

        sinon.assert.notCalled(console.debug)
        sinon.assert.notCalled(console.error)
      })

      it('should enable the logger', () => {
        log.toggle(false)
        log.toggle(true)
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(console.debug, 'debug')
        sinon.assert.calledWith(console.error, error)
      })

      it('should set minimum log level when enabled with logLevel argument set to a valid string', () => {
        log.toggle(true, 'error')
        log.debug('debug')
        log.error(error)

        sinon.assert.notCalled(console.debug)
        sinon.assert.calledWith(console.error, error)
      })

      it('should set default log level when enabled with logLevel argument set to an invalid string', () => {
        log.toggle(true, 'not a real log level')
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(console.debug, 'debug')
        sinon.assert.calledWith(console.error, error)
      })

      it('should set min log level when enabled w/logLevel arg set to valid string w/wrong case or whitespace', () => {
        log.toggle(true, ' ErRoR   ')
        log.debug('debug')
        log.error(error)

        sinon.assert.notCalled(console.debug)
        sinon.assert.calledWith(console.error, error)
      })

      it('should log all log levels greater than or equal to minimum log level', () => {
        log.toggle(true, 'debug')
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(console.debug, 'debug')
        sinon.assert.calledWith(console.error, error)
      })

      it('should enable default log level when enabled with logLevel argument set to invalid input', () => {
        log.toggle(true, ['trace', 'info', 'eror'])
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(console.debug, 'debug')
        sinon.assert.calledWith(console.error, error)
      })

      it('should enable default log level when enabled without logLevel argument', () => {
        log.toggle(true)
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(console.debug, 'debug')
        sinon.assert.calledWith(console.error, error)
      })
    })

    describe('use', () => {
      it('should set the underlying logger when valid', () => {
        log.use(logger)
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(logger.debug, 'debug')
        sinon.assert.calledWith(logger.error, error)
      })

      it('be a no op with an empty logger', () => {
        log.use(null)
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(console.debug, 'debug')
        sinon.assert.calledWith(console.error, error)
      })

      it('be a no op with an invalid logger', () => {
        log.use('invalid')
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(console.debug, 'debug')
        sinon.assert.calledWith(console.error, error)
      })
    })

    describe('reset', () => {
      it('should reset the logger', () => {
        log.use(logger)
        log.reset()
        log.toggle(true)
        log.debug('debug')
        log.error(error)

        sinon.assert.calledWith(console.debug, 'debug')
        sinon.assert.calledWith(console.error, error)
      })

      it('should reset the toggle', () => {
        log.use(logger)
        log.reset()
        log.debug('debug')
        log.error(error)

        sinon.assert.notCalled(console.debug)
        sinon.assert.notCalled(console.error)
      })

      it('should reset the minimum log level to defaults', () => {
        log.use(logger)
        log.toggle(true, 'error')
        log.reset()
        log.toggle(true)
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
        assert.strictEqual(typeof consoleErrorArg, 'object')
        assert.strictEqual(consoleErrorArg.message, 'message')
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
        logWriter = require('../src/log/writer')
      })

      afterEach(() => {
        logWriter.reset()
      })

      describe('error', () => {
        it('should call logger error', () => {
          logWriter.error(error)

          sinon.assert.calledOnceWithExactly(console.error, error)
        })

        it('should call console.error no matter enable flag value', () => {
          logWriter.toggle(false)
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
          logWriter.use(logger)
          logWriter.warn('warn')

          sinon.assert.calledOnceWithExactly(logger.debug, 'warn')
        })

        it('should call console.warn no matter enable flag value', () => {
          logWriter.toggle(false)
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
          logWriter.use(logger)
          logWriter.info('info')

          sinon.assert.calledOnceWithExactly(logger.debug, 'info')
        })

        it('should call console.info no matter enable flag value', () => {
          logWriter.toggle(false)
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
          logWriter.toggle(false)
          logWriter.debug('debug')

          sinon.assert.calledOnceWithExactly(console.debug, 'debug')
        })
      })
    })
  })
})
