'use strict'

/* eslint-disable no-console */

describe('log', () => {
  let log
  let logger
  let error

  beforeEach(() => {
    sinon.stub(console, 'log')
    sinon.stub(console, 'error')
    sinon.stub(console, 'warn')

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
    console.log.restore()
    console.error.restore()
    console.warn.restore()
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

  describe('debug', () => {
    it('should log to console by default', () => {
      log.debug('debug')

      expect(console.log).to.have.been.calledWith('debug')
    })

    it('should support callbacks that return a message', () => {
      log.debug(() => 'debug')

      expect(console.log).to.have.been.calledWith('debug')
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

      expect(console.log).to.not.have.been.called
      expect(console.error).to.not.have.been.called
    })

    it('should enable the logger', () => {
      log.toggle(false)
      log.toggle(true)
      log.debug('debug')
      log.error(error)

      expect(console.log).to.have.been.calledWith('debug')
      expect(console.error).to.have.been.calledWith(error)
    })

    it('should set custom log levels when enabled with customLogLevels argument set to an array of log levels', () => {
      log.toggle(true, ['error', 'info'])
      log.debug('debug')
      log.error(error)

      expect(console.log).to.not.have.been.called
      expect(console.error).to.have.been.calledWith(error)
    })

    it('should set custom log levels when enabled with customLogLevels arg as CSV string of log levels', () => {
      log.toggle(true, 'error,info')
      log.debug('debug')
      log.error(error)

      expect(console.log).to.not.have.been.called
      expect(console.error).to.have.been.calledWith(error)
    })

    it('should log a warning if enabled with an improperly formatted Array', () => {
      log.toggle(true, [{ 'invalid_key': 'invalid_value' }])

      expect(console.warn).to.have.been.calledOnce
    })

    it('should enable error and debug logs when enabled with customLogLevels argument set to null', () => {
      log.toggle(true, null)
      log.debug('debug')
      log.error(error)

      expect(console.log).to.have.been.calledWith('debug')
      expect(console.error).to.have.been.calledWith(error)
    })

    it('should enable error and debug logs when enabled without customLogLevels argument', () => {
      log.toggle(true)
      log.debug('debug')
      log.error(error)

      expect(console.log).to.have.been.calledWith('debug')
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

      expect(console.log).to.have.been.calledWith('debug')
      expect(console.error).to.have.been.calledWith(error)
    })

    it('be a no op with an invalid logger', () => {
      log.use('invalid')
      log.debug('debug')
      log.error(error)

      expect(console.log).to.have.been.calledWith('debug')
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

      expect(console.log).to.have.been.calledWith('debug')
      expect(console.error).to.have.been.calledWith(error)
    })

    it('should reset the toggle', () => {
      log.use(logger)
      log.reset()
      log.debug('debug')
      log.error(error)

      expect(console.log).to.not.have.been.called
      expect(console.error).to.not.have.been.called
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
