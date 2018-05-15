'use strict'

/* eslint-disable no-console */

describe('log', () => {
  let log
  let logger

  beforeEach(() => {
    sinon.stub(console, 'log')
    sinon.stub(console, 'error')

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
  })

  it('should log debug to console by default', () => {
    log.debug('debug')

    expect(console.log).to.have.been.calledWith('debug')
  })

  it('should log errors to console by default', () => {
    const err = new Error()

    log.error(err)

    expect(console.error).to.have.been.calledWith(err)
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

  describe('toggle', () => {
    it('should disable the logger', () => {
      log.toggle(false)
      log.debug('debug')
      log.error('error')

      expect(console.log).to.not.have.been.called
      expect(console.error).to.not.have.been.called
    })

    it('should enable the logger', () => {
      log.toggle(false)
      log.toggle(true)
      log.debug('debug')
      log.error('error')

      expect(console.log).to.have.been.calledWith('debug')
      expect(console.error).to.have.been.calledWith('error')
    })
  })

  describe('use', () => {
    it('should set the underlying logger when valid', () => {
      log.use(logger)
      log.debug('debug')
      log.error('error')

      expect(logger.debug).to.have.been.calledWith('debug')
      expect(logger.error).to.have.been.calledWith('error')
    })

    it('be a no op with an empty logger', () => {
      log.use(null)
      log.debug('debug')
      log.error('error')

      expect(console.log).to.have.been.calledWith('debug')
      expect(console.error).to.have.been.calledWith('error')
    })

    it('be a no op with an invalid logger', () => {
      log.use('invalid')
      log.debug('debug')
      log.error('error')

      expect(console.log).to.have.been.calledWith('debug')
      expect(console.error).to.have.been.calledWith('error')
    })
  })

  describe('reset', () => {
    it('should reset the logger', () => {
      log.use(logger)
      log.reset()
      log.toggle(true)
      log.debug('debug')
      log.error('error')

      expect(console.log).to.have.been.calledWith('debug')
      expect(console.error).to.have.been.calledWith('error')
    })

    it('should reset the toggle', () => {
      log.use(logger)
      log.reset()
      log.debug('debug')
      log.error('error')

      expect(console.log).to.not.have.been.called
      expect(console.error).to.not.have.been.called
    })
  })
})
