'use strict'

describe('log', () => {
  let log

  beforeEach(() => {
    log = require('../src/log')
  })

  describe('without a logger', () => {
    it('should be a no op', () => {
      expect(log.debug).to.not.throw()
      expect(log.error).to.not.throw()
    })
  })

  describe('with an empty logger', () => {
    beforeEach(() => {
      log.use(null)
    })

    it('should be a no op', () => {
      expect(log.debug).to.not.throw()
      expect(log.error).to.not.throw()
    })
  })

  describe('with an invalid logger', () => {
    beforeEach(() => {
      log.use('invalid')
    })

    it('should be a no op', () => {
      expect(log.debug).to.not.throw()
      expect(log.error).to.not.throw()
    })
  })

  describe('with a valid logger', () => {
    let logger

    beforeEach(() => {
      logger = {
        debug: sinon.spy(),
        error: sinon.spy()
      }

      log.use(logger)
    })

    it('should call the underlying logger', () => {
      log.debug('debug')
      log.error('error')

      expect(logger.debug).to.have.been.calledWith('debug')
      expect(logger.error).to.have.been.calledWith('error')
    })
  })
})
