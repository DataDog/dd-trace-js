'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
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
      expect(log.getConfig).to.be.a('function')
    })

    it('should be configured with default config if no environment variables are set', () => {
      const log = require('../src/log')
      expect(log.getConfig()).to.deep.equal({
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
      expect(log.getConfig()).to.deep.equal({
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
      expect(config).to.have.property('enabled', false)
      expect(config).to.have.property('logLevel', 'error')
    })

    it('should initialize with OTEL environment variables when DD env vars are not set', () => {
      process.env.OTEL_LOG_LEVEL = 'debug'
      const config = proxyquire('../src/log', {}).getConfig()
      expect(config).to.have.property('enabled', true)
      expect(config).to.have.property('logLevel', 'debug')
    })

    it('should initialize from environment variables', () => {
      process.env.DD_TRACE_DEBUG = 'true'
      const config = proxyquire('../src/log', {}).getConfig()
      expect(config).to.have.property('enabled', true)
    })

    it('should read case-insensitive booleans from environment variables', () => {
      process.env.DD_TRACE_DEBUG = 'TRUE'
      const config = proxyquire('../src/log', {}).getConfig()
      expect(config).to.have.property('enabled', true)
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
      expect(() => {
        log
          .use(logger)
          .toggle(true)
          .error('error')
          .debug('debug')
          .reset()
      }).to.not.throw()
    })

    it('should call the logger in a noop context', () => {
      logger.debug = () => {
        expect(storage('legacy').getStore()).to.have.property('noop', true)
      }

      log.use(logger).debug('debug')
    })

    describe('debug', () => {
      it('should log to console by default', () => {
        log.debug('debug')

        expect(console.debug).to.have.been.calledWith('debug')
      })

      it('should support callbacks that return a message', () => {
        log.debug(() => 'debug')

        expect(console.debug).to.have.been.calledWith('debug')
      })
    })

    describe('trace', () => {
      it('should not log to console by default', () => {
        log.trace('trace')

        expect(console.debug).to.not.have.been.called
      })

      it('should log to console after setting log level to trace', function foo () {
        class Foo {
          constructor () {
            this.bar = 'baz'
          }
        }

        log.toggle(true, 'trace')
        log.trace('argument', { hello: 'world' }, new Foo())

        expect(console.debug).to.have.been.calledOnce
        expect(console.debug.firstCall.args[0]).to.match(
          /^Trace: Test.foo\('argument', { hello: 'world' }, Foo { bar: 'baz' }\)/
        )
        expect(console.debug.firstCall.args[0].split('\n').length).to.be.gte(3)
      })
    })

    describe('error', () => {
      it('should log to console by default', () => {
        log.error(error)

        expect(console.error).to.have.been.calledWith(error)
      })

      it('should support callbacks that return a error', () => {
        log.error(() => error)

        expect(console.error).to.have.been.calledWith(error)
      })

      it('should convert strings to errors', () => {
        log.error('error')

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'error')
      })

      // NOTE: There is no usage for this case. should we continue supporting it?
      it('should convert empty values to errors', () => {
        log.error()

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'undefined')
      })

      it('should convert invalid types to errors', () => {
        log.error(123)

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', '123')
      })

      it('should reuse error messages for non-errors', () => {
        log.error({ message: 'test' })

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'test')
      })

      it('should convert messages from callbacks to errors', () => {
        log.error(() => 'error')

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'error')
      })

      it('should allow a message + Error', () => {
        log.error('this is an error', new Error('cause'))

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'this is an error')
        expect(console.error.secondCall.args[0]).to.be.instanceof(Error)
        expect(console.error.secondCall.args[0]).to.have.property('message', 'cause')
      })

      it('should allow a templated message', () => {
        log.error('this is an error of type: %s code: %i', 'ERR', 42)

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'this is an error of type: ERR code: 42')
      })

      it('should allow a templated message + Error', () => {
        log.error('this is an error of type: %s code: %i', 'ERR', 42, new Error('cause'))

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'this is an error of type: ERR code: 42')
        expect(console.error.secondCall.args[0]).to.be.instanceof(Error)
        expect(console.error.secondCall.args[0]).to.have.property('message', 'cause')
      })

      it('should allow a message + Error + LogConfig', () => {
        log.error('this is an error with a log config', log.NO_TRANSMIT)

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'this is an error with a log config')
      })

      it('should allow a message + NoTransmitError', () => {
        log.error('this is an error without a log config', new log.NoTransmitError('bad underlying thing'))

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'this is an error without a log config')
        expect(console.error.secondCall.args[0]).to.be.instanceof(Error)
        expect(console.error.secondCall.args[0]).to.have.property('message', 'bad underlying thing')
      })
    })

    describe('toggle', () => {
      it('should disable the logger', () => {
        log.toggle(false)
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.not.have.been.called
        expect(console.error).to.not.have.been.called
      })

      it('should enable the logger', () => {
        log.toggle(false)
        log.toggle(true)
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
      })

      it('should set minimum log level when enabled with logLevel argument set to a valid string', () => {
        log.toggle(true, 'error')
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.not.have.been.called
        expect(console.error).to.have.been.calledWith(error)
      })

      it('should set default log level when enabled with logLevel argument set to an invalid string', () => {
        log.toggle(true, 'not a real log level')
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
      })

      it('should set min log level when enabled w/logLevel arg set to valid string w/wrong case or whitespace', () => {
        log.toggle(true, ' ErRoR   ')
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.not.have.been.called
        expect(console.error).to.have.been.calledWith(error)
      })

      it('should log all log levels greater than or equal to minimum log level', () => {
        log.toggle(true, 'debug')
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
      })

      it('should enable default log level when enabled with logLevel argument set to invalid input', () => {
        log.toggle(true, ['trace', 'info', 'eror'])
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
      })

      it('should enable default log level when enabled without logLevel argument', () => {
        log.toggle(true)
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
      })
    })

    describe('use', () => {
      it('should set the underlying logger when valid', () => {
        log.use(logger)
        log.debug('debug')
        log.error(error)

        expect(logger.debug).to.have.been.calledWith('debug')
        expect(logger.error).to.have.been.calledWith(error)
      })

      it('be a no op with an empty logger', () => {
        log.use(null)
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
      })

      it('be a no op with an invalid logger', () => {
        log.use('invalid')
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
      })
    })

    describe('reset', () => {
      it('should reset the logger', () => {
        log.use(logger)
        log.reset()
        log.toggle(true)
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
      })

      it('should reset the toggle', () => {
        log.use(logger)
        log.reset()
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.not.have.been.called
        expect(console.error).to.not.have.been.called
      })

      it('should reset the minimum log level to defaults', () => {
        log.use(logger)
        log.toggle(true, 'error')
        log.reset()
        log.toggle(true)
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
      })
    })

    describe('deprecate', () => {
      it('should log a deprecation warning', () => {
        log.deprecate('test', 'message')

        expect(console.error).to.have.been.calledOnce
        const consoleErrorArg = console.error.getCall(0).args[0]
        expect(typeof consoleErrorArg).to.be.eq('object')
        expect(consoleErrorArg.message).to.be.eq('message')
      })

      it('should only log once for a given code', () => {
        log.deprecate('test', 'message')
        log.deprecate('test', 'message')

        expect(console.error).to.have.been.calledOnce
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

          expect(console.error).to.have.been.calledOnceWith(error)
        })

        it('should call console.error no matter enable flag value', () => {
          logWriter.toggle(false)
          logWriter.error(error)

          expect(console.error).to.have.been.calledOnceWith(error)
        })
      })

      describe('warn', () => {
        it('should call logger warn', () => {
          logWriter.warn('warn')

          expect(console.warn).to.have.been.calledOnceWith('warn')
        })

        it('should call logger debug if warn is not provided', () => {
          logWriter.use(logger)
          logWriter.warn('warn')

          expect(logger.debug).to.have.been.calledOnceWith('warn')
        })

        it('should call console.warn no matter enable flag value', () => {
          logWriter.toggle(false)
          logWriter.warn('warn')

          expect(console.warn).to.have.been.calledOnceWith('warn')
        })
      })

      describe('info', () => {
        it('should call logger info', () => {
          logWriter.info('info')

          expect(console.info).to.have.been.calledOnceWith('info')
        })

        it('should call logger debug if info is not provided', () => {
          logWriter.use(logger)
          logWriter.info('info')

          expect(logger.debug).to.have.been.calledOnceWith('info')
        })

        it('should call console.info no matter enable flag value', () => {
          logWriter.toggle(false)
          logWriter.info('info')

          expect(console.info).to.have.been.calledOnceWith('info')
        })
      })

      describe('debug', () => {
        it('should call logger debug', () => {
          logWriter.debug('debug')

          expect(console.debug).to.have.been.calledOnceWith('debug')
        })

        it('should call console.debug no matter enable flag value', () => {
          logWriter.toggle(false)
          logWriter.debug('debug')

          expect(console.debug).to.have.been.calledOnceWith('debug')
        })
      })
    })
  })
})
