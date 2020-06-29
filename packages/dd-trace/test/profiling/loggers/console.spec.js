'use strict'

/* eslint-disable no-console */

const sinon = require('sinon')

describe('loggers/console', () => {
  let ConsoleLogger

  beforeEach(() => {
    sinon.stub(console, 'debug')
    sinon.stub(console, 'warn')
    sinon.stub(console, 'error')

    ConsoleLogger = require('../../../src/profiling/loggers/console').ConsoleLogger
  })

  afterEach(() => {
    console.debug.restore()
    console.warn.restore()
    console.error.restore()
  })

  it('should call the underlying console for error', () => {
    const logger = new ConsoleLogger()

    logger.error('error')
    logger.warn('warn')
    logger.debug('debug')

    sinon.assert.calledOnce(console.error)
    sinon.assert.calledWith(console.error, 'error')
    sinon.assert.notCalled(console.debug)
    sinon.assert.notCalled(console.warn)
  })

  it('should call the underlying console for warn', () => {
    const logger = new ConsoleLogger({ level: 'warn' })

    logger.error('error')
    logger.warn('warn')
    logger.debug('debug')

    sinon.assert.calledOnce(console.error)
    sinon.assert.calledWith(console.error, 'error')
    sinon.assert.calledOnce(console.warn)
    sinon.assert.calledWith(console.warn, 'warn')
    sinon.assert.notCalled(console.debug)
  })

  it('should call the underlying console for debug', () => {
    const logger = new ConsoleLogger({ level: 'debug' })

    logger.error('error')
    logger.warn('warn')
    logger.debug('debug')

    sinon.assert.calledOnce(console.error)
    sinon.assert.calledWith(console.error, 'error')
    sinon.assert.calledOnce(console.warn)
    sinon.assert.calledWith(console.warn, 'warn')
    sinon.assert.calledOnce(console.debug)
    sinon.assert.calledWith(console.debug, 'debug')
  })
})
