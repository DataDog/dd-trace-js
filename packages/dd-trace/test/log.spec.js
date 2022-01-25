'use strict'

const { expect } = require('chai')
const { storage } = require('../../datadog-core')

/* eslint-disable no-console */

describe('log', () => {
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

    log = require('../src/log')
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
      expect(storage.getStore()).to.have.property('noop', true)
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

      expect(console.error).to.have.been.calledWith('message')
    })

    it('should only log once for a given code', () => {
      log.deprecate('test', 'message')
      log.deprecate('test', 'message')

      expect(console.error).to.have.been.calledOnce
    })
  })
})
