'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('./setup/core')
const { storage } = require('../../datadog-core')

/* eslint-disable no-console */

describe('log', () => {
  describe('config', () => {
    let env

    const reloadLog = () => {
      const logWriter = {
        configure: sinon.spy(),
      }

      const log = proxyquire.noPreserveCache()('../src/log', {
        './writer': logWriter,
      })

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

    it('should configure without debug enabled by default', () => {
      const { log, logWriter } = reloadLog()

      assert.strictEqual(log.configure({}), false)
      sinon.assert.calledOnceWithExactly(logWriter.configure, false, undefined, undefined)
    })

    it('should configure from DD_TRACE_DEBUG when that source is configured', () => {
      process.env.DD_TRACE_DEBUG = 'false'
      const { log, logWriter } = reloadLog()

      assert.strictEqual(log.configure({ DD_TRACE_DEBUG: true }), true)
      sinon.assert.calledOnceWithExactly(logWriter.configure, true, undefined, undefined)
    })

    it('should configure from DD_TRACE_DEBUG when disabled', () => {
      process.env.DD_TRACE_DEBUG = 'false'
      const { log, logWriter } = reloadLog()

      assert.strictEqual(log.configure({ DD_TRACE_DEBUG: false }), false)
      sinon.assert.calledOnceWithExactly(logWriter.configure, false, undefined, undefined)
    })

    it('should pass the logger option to the writer', () => {
      const { log, logWriter } = reloadLog()
      const logger = {
        debug: () => {},
        error: () => {},
      }

      log.configure({ DD_TRACE_DEBUG: true, logLevel: 'debug', logger })

      sinon.assert.calledOnceWithExactly(logWriter.configure, true, 'debug', logger)
    })

    it('should pass the final log level to the writer', () => {
      const { log, logWriter } = reloadLog()

      assert.strictEqual(log.configure({ DD_TRACE_DEBUG: true, logLevel: 'error' }), true)
      sinon.assert.calledOnceWithExactly(logWriter.configure, true, 'error', undefined)
    })

    it('should replay buffered logs when configured', () => {
      const log = proxyquire.noPreserveCache()('../src/log', {})
      const logger = {
        debug: sinon.spy(),
        info: sinon.spy(),
        warn: sinon.spy(),
        error: sinon.spy(),
      }

      log.debug('early debug')
      log.info('early info')
      log.warn('early %s', 'warning')
      log.error('early error')
      log.errorWithoutTelemetry('early error without telemetry')
      log.configure({ DD_TRACE_DEBUG: true, logLevel: 'debug', logger })

      sinon.assert.calledOnceWithExactly(logger.debug, 'early debug')
      sinon.assert.calledOnceWithExactly(logger.info, 'early info')
      sinon.assert.calledOnceWithExactly(logger.warn, 'early warning')
      sinon.assert.calledTwice(logger.error)
      assert.strictEqual(logger.error.firstCall.args[0].message, 'early error')
      assert.strictEqual(logger.error.secondCall.args[0], 'early error without telemetry')
    })

    it('should drop buffered logs when disabled', () => {
      const log = proxyquire.noPreserveCache()('../src/log', {})
      const logger = {
        debug: sinon.spy(),
        warn: sinon.spy(),
        error: sinon.spy(),
      }

      log.warn('early %s', 'warning')
      log.configure({ DD_TRACE_DEBUG: false, logLevel: 'debug', logger })

      sinon.assert.notCalled(logger.warn)
    })

    it('should preserve buffered trace call sites', function foo () {
      const log = proxyquire.noPreserveCache()('../src/log', {})
      const logger = {
        debug: sinon.spy(),
        error: sinon.spy(),
      }

      log.trace('early trace')
      log.configure({ DD_TRACE_DEBUG: true, logLevel: 'trace', logger })

      sinon.assert.calledOnce(logger.debug)
      assert.match(logger.debug.firstCall.args[0], /^Trace: Context.foo\('early trace'\)/)
    })

    it('should replace write methods with noops when disabled after being enabled', () => {
      const log = proxyquire.noPreserveCache()('../src/log', {})
      const logger = {
        debug: sinon.spy(),
        error: sinon.spy(),
      }

      log.configure({ DD_TRACE_DEBUG: true, logLevel: 'debug', logger })
      log.debug('before disable')
      log.configure({ DD_TRACE_DEBUG: false, logLevel: 'debug', logger })
      log.debug('after disable')
      log.error('after disable')

      sinon.assert.calledOnceWithExactly(logger.debug, 'before disable')
      sinon.assert.notCalled(logger.error)
    })
  })

  describe('general usage', () => {
    let env
    let log
    let logger
    let error

    function loadConfiguredLog (options = {}) {
      log = proxyquire.noPreserveCache()('../src/log', {})
      log.configure({ DD_TRACE_DEBUG: true, logLevel: 'debug', ...options })
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

    it('should not return itself from logger methods', () => {
      loadConfiguredLog({ logger })

      assert.strictEqual(log.trace('trace'), undefined)
      assert.strictEqual(log.debug('debug'), undefined)
      assert.strictEqual(log.info('info'), undefined)
      assert.strictEqual(log.warn('warn'), undefined)
      assert.strictEqual(log.error('error'), undefined)
      assert.strictEqual(log.errorWithoutTelemetry('error without telemetry'), undefined)
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
        const debugMessage = console.debug.firstCall.args[0]
        assert.match(debugMessage,
          /^Trace: Context.foo\('argument', { hello: 'world' }, Foo { bar: 'baz' }\)/
        )
        const lineCount = debugMessage.split('\n').length
        assert.ok(lineCount >= 3, `Expected at least 3 lines in trace, got ${lineCount}: ${inspect(debugMessage)}`)
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
        loadConfiguredLog({ DD_TRACE_DEBUG: false })
        log.debug('debug')
        log.error(error)

        sinon.assert.notCalled(console.debug)
        sinon.assert.notCalled(console.error)
      })

      it('should enable the logger when DD_TRACE_DEBUG is true', () => {
        loadConfiguredLog({ DD_TRACE_DEBUG: true })
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
