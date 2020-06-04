'use strict'

const expect = require('chai').expect
const sinon = require('sinon')

describe('loggers/composite', () => {
  let CompositeLogger
  let testLogger
  let loggers

  beforeEach(() => {
    testLogger = {
      debug: sinon.spy(),
      warn: sinon.spy(),
      error: sinon.spy()
    }

    loggers = [testLogger]

    CompositeLogger = require('../../../src/profiling/loggers/composite').CompositeLogger
  })

  it('should call the underlying loggers for debug', () => {
    const logger = new CompositeLogger({ loggers })

    logger.debug('message')

    sinon.assert.calledOnce(testLogger.debug)
    sinon.assert.calledWith(testLogger.debug, 'message')
  })

  it('should call the underlying loggers for warn', () => {
    const logger = new CompositeLogger({ loggers })

    logger.warn('message')

    sinon.assert.calledOnce(testLogger.warn)
    sinon.assert.calledWith(testLogger.warn, 'message')
  })

  it('should call the underlying loggers for error', () => {
    const logger = new CompositeLogger({ loggers })

    logger.error('message')

    sinon.assert.calledOnce(testLogger.error)
    sinon.assert.calledWith(testLogger.error, 'message')
  })

  it('should default to noop', () => {
    const logger = new CompositeLogger()

    expect(() => logger.error('message')).to.not.throw
  })
})
