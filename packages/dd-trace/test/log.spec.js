'use strict'

const t = require('tap')
require('./setup/core')

const { expect } = require('chai')
const { storage } = require('../../datadog-core')

/* eslint-disable no-console */

t.test('log', t => {
  t.test('config', t => {
    let env

    t.beforeEach(() => {
      env = process.env
      process.env = {}
    })

    t.afterEach(() => {
      process.env = env
    })

    t.test('should have getConfig function', t => {
      const log = require('../src/log')
      expect(log.getConfig).to.be.a('function')
      t.end()
    })

    t.test('should be configured with default config if no environment variables are set', t => {
      const log = require('../src/log')
      expect(log.getConfig()).to.deep.equal({
        enabled: false,
        logger: undefined,
        logLevel: 'debug'
      })
      t.end()
    })

    t.test('should not be possbile to mutate config object returned by getConfig', t => {
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
      t.end()
    })

    t.test('should initialize from environment variables with DD env vars taking precedence OTEL env vars', t => {
      process.env.DD_TRACE_LOG_LEVEL = 'error'
      process.env.DD_TRACE_DEBUG = 'false'
      process.env.OTEL_LOG_LEVEL = 'debug'
      const config = proxyquire('../src/log', {}).getConfig()
      expect(config).to.have.property('enabled', false)
      expect(config).to.have.property('logLevel', 'error')
      t.end()
    })

    t.test('should initialize with OTEL environment variables when DD env vars are not set', t => {
      process.env.OTEL_LOG_LEVEL = 'debug'
      const config = proxyquire('../src/log', {}).getConfig()
      expect(config).to.have.property('enabled', true)
      expect(config).to.have.property('logLevel', 'debug')
      t.end()
    })

    t.test('should initialize from environment variables', t => {
      process.env.DD_TRACE_DEBUG = 'true'
      const config = proxyquire('../src/log', {}).getConfig()
      expect(config).to.have.property('enabled', true)
      t.end()
    })

    t.test('should read case-insensitive booleans from environment variables', t => {
      process.env.DD_TRACE_DEBUG = 'TRUE'
      const config = proxyquire('../src/log', {}).getConfig()
      expect(config).to.have.property('enabled', true)
      t.end()
    })
    t.end()
  })

  t.test('general usage', t => {
    let log
    let logger
    let error

    t.beforeEach(() => {
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

    t.afterEach(() => {
      log.reset()
      console.info.restore()
      console.error.restore()
      console.warn.restore()
      console.debug.restore()
    })

    t.test('should support chaining', t => {
      expect(() => {
        log
          .use(logger)
          .toggle(true)
          .error('error')
          .debug('debug')
          .reset()
      }).to.not.throw()
      t.end()
    })

    t.test('should call the logger in a noop context', t => {
      logger.debug = () => {
        expect(storage('legacy').getStore()).to.have.property('noop', true)
      }

      log.use(logger).debug('debug')
      t.end()
    })

    t.test('debug', t => {
      t.test('should log to console by default', t => {
        log.debug('debug')

        expect(console.debug).to.have.been.calledWith('debug')
        t.end()
      })

      t.test('should support callbacks that return a message', t => {
        log.debug(() => 'debug')

        expect(console.debug).to.have.been.calledWith('debug')
        t.end()
      })
      t.end()
    })

    t.test('trace', t => {
      t.test('should not log to console by default', t => {
        log.trace('trace')

        expect(console.debug).to.not.have.been.called
        t.end()
      })

      t.test('should log to console after setting log level to trace', function foo (t) {
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
        t.end()
      })
      t.end()
    })

    t.test('error', t => {
      t.test('should log to console by default', t => {
        log.error(error)

        expect(console.error).to.have.been.calledWith(error)
        t.end()
      })

      t.test('should support callbacks that return a error', t => {
        log.error(() => error)

        expect(console.error).to.have.been.calledWith(error)
        t.end()
      })

      t.test('should convert strings to errors', t => {
        log.error('error')

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'error')
        t.end()
      })

      // NOTE: There is no usage for this case. should we continue supporting it?
      t.test('should convert empty values to errors', t => {
        log.error()

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'undefined')
        t.end()
      })

      t.test('should convert invalid types to errors', t => {
        log.error(123)

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', '123')
        t.end()
      })

      t.test('should reuse error messages for non-errors', t => {
        log.error({ message: 'test' })

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'test')
        t.end()
      })

      t.test('should convert messages from callbacks to errors', t => {
        log.error(() => 'error')

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'error')
        t.end()
      })

      t.test('should allow a message + Error', t => {
        log.error('this is an error', new Error('cause'))

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'this is an error')
        expect(console.error.secondCall.args[0]).to.be.instanceof(Error)
        expect(console.error.secondCall.args[0]).to.have.property('message', 'cause')
        t.end()
      })

      t.test('should allow a templated message', t => {
        log.error('this is an error of type: %s code: %i', 'ERR', 42)

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'this is an error of type: ERR code: 42')
        t.end()
      })

      t.test('should allow a templated message + Error', t => {
        log.error('this is an error of type: %s code: %i', 'ERR', 42, new Error('cause'))

        expect(console.error).to.have.been.called
        expect(console.error.firstCall.args[0]).to.be.instanceof(Error)
        expect(console.error.firstCall.args[0]).to.have.property('message', 'this is an error of type: ERR code: 42')
        expect(console.error.secondCall.args[0]).to.be.instanceof(Error)
        expect(console.error.secondCall.args[0]).to.have.property('message', 'cause')
        t.end()
      })
      t.end()
    })

    t.test('toggle', t => {
      t.test('should disable the logger', t => {
        log.toggle(false)
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.not.have.been.called
        expect(console.error).to.not.have.been.called
        t.end()
      })

      t.test('should enable the logger', t => {
        log.toggle(false)
        log.toggle(true)
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
        t.end()
      })

      t.test('should set minimum log level when enabled with logLevel argument set to a valid string', t => {
        log.toggle(true, 'error')
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.not.have.been.called
        expect(console.error).to.have.been.calledWith(error)
        t.end()
      })

      t.test('should set default log level when enabled with logLevel argument set to an invalid string', t => {
        log.toggle(true, 'not a real log level')
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
        t.end()
      })

      t.test(
        'should set min log level when enabled w/logLevel arg set to valid string w/wrong case or whitespace',
        t => {
          log.toggle(true, ' ErRoR   ')
          log.debug('debug')
          log.error(error)

          expect(console.debug).to.not.have.been.called
          expect(console.error).to.have.been.calledWith(error)
          t.end()
        }
      )

      t.test('should log all log levels greater than or equal to minimum log level', t => {
        log.toggle(true, 'debug')
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
        t.end()
      })

      t.test('should enable default log level when enabled with logLevel argument set to invalid input', t => {
        log.toggle(true, ['trace', 'info', 'eror'])
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
        t.end()
      })

      t.test('should enable default log level when enabled without logLevel argument', t => {
        log.toggle(true)
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
        t.end()
      })
      t.end()
    })

    t.test('use', t => {
      t.test('should set the underlying logger when valid', t => {
        log.use(logger)
        log.debug('debug')
        log.error(error)

        expect(logger.debug).to.have.been.calledWith('debug')
        expect(logger.error).to.have.been.calledWith(error)
        t.end()
      })

      t.test('be a no op with an empty logger', t => {
        log.use(null)
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
        t.end()
      })

      t.test('be a no op with an invalid logger', t => {
        log.use('invalid')
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
        t.end()
      })
      t.end()
    })

    t.test('reset', t => {
      t.test('should reset the logger', t => {
        log.use(logger)
        log.reset()
        log.toggle(true)
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
        t.end()
      })

      t.test('should reset the toggle', t => {
        log.use(logger)
        log.reset()
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.not.have.been.called
        expect(console.error).to.not.have.been.called
        t.end()
      })

      t.test('should reset the minimum log level to defaults', t => {
        log.use(logger)
        log.toggle(true, 'error')
        log.reset()
        log.toggle(true)
        log.debug('debug')
        log.error(error)

        expect(console.debug).to.have.been.calledWith('debug')
        expect(console.error).to.have.been.calledWith(error)
        t.end()
      })
      t.end()
    })

    t.test('deprecate', t => {
      t.test('should log a deprecation warning', t => {
        log.deprecate('test', 'message')

        expect(console.error).to.have.been.calledOnce
        const consoleErrorArg = console.error.getCall(0).args[0]
        expect(typeof consoleErrorArg).to.be.eq('object')
        expect(consoleErrorArg.message).to.be.eq('message')
        t.end()
      })

      t.test('should only log once for a given code', t => {
        log.deprecate('test', 'message')
        log.deprecate('test', 'message')

        expect(console.error).to.have.been.calledOnce
        t.end()
      })
      t.end()
    })

    t.test('logWriter', t => {
      let logWriter

      t.beforeEach(() => {
        logWriter = require('../src/log/writer')
      })

      t.afterEach(() => {
        logWriter.reset()
      })

      t.test('error', t => {
        t.test('should call logger error', t => {
          logWriter.error(error)

          expect(console.error).to.have.been.calledOnceWith(error)
          t.end()
        })

        t.test('should call console.error no matter enable flag value', t => {
          logWriter.toggle(false)
          logWriter.error(error)

          expect(console.error).to.have.been.calledOnceWith(error)
          t.end()
        })
        t.end()
      })

      t.test('warn', t => {
        t.test('should call logger warn', t => {
          logWriter.warn('warn')

          expect(console.warn).to.have.been.calledOnceWith('warn')
          t.end()
        })

        t.test('should call logger debug if warn is not provided', t => {
          logWriter.use(logger)
          logWriter.warn('warn')

          expect(logger.debug).to.have.been.calledOnceWith('warn')
          t.end()
        })

        t.test('should call console.warn no matter enable flag value', t => {
          logWriter.toggle(false)
          logWriter.warn('warn')

          expect(console.warn).to.have.been.calledOnceWith('warn')
          t.end()
        })
        t.end()
      })

      t.test('info', t => {
        t.test('should call logger info', t => {
          logWriter.info('info')

          expect(console.info).to.have.been.calledOnceWith('info')
          t.end()
        })

        t.test('should call logger debug if info is not provided', t => {
          logWriter.use(logger)
          logWriter.info('info')

          expect(logger.debug).to.have.been.calledOnceWith('info')
          t.end()
        })

        t.test('should call console.info no matter enable flag value', t => {
          logWriter.toggle(false)
          logWriter.info('info')

          expect(console.info).to.have.been.calledOnceWith('info')
          t.end()
        })
        t.end()
      })

      t.test('debug', t => {
        t.test('should call logger debug', t => {
          logWriter.debug('debug')

          expect(console.debug).to.have.been.calledOnceWith('debug')
          t.end()
        })

        t.test('should call console.debug no matter enable flag value', t => {
          logWriter.toggle(false)
          logWriter.debug('debug')

          expect(console.debug).to.have.been.calledOnceWith('debug')
          t.end()
        })
        t.end()
      })
      t.end()
    })
    t.end()
  })
  t.end()
})
