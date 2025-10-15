'use strict'

const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')

require('../../setup/core')

describe('loggers/console', () => {
  let ConsoleLogger
  let debugStub
  let infoStub
  let warnStub
  let errorStub

  beforeEach(() => {
    debugStub = sinon.stub(console, 'debug')
    infoStub = sinon.stub(console, 'info')
    warnStub = sinon.stub(console, 'warn')
    errorStub = sinon.stub(console, 'error')

    ConsoleLogger = require('../../../src/profiling/loggers/console').ConsoleLogger
  })

  afterEach(() => {
    debugStub.restore()
    infoStub.restore()
    warnStub.restore()
    errorStub.restore()
  })

  it('should call the underlying console for error', () => {
    const logger = new ConsoleLogger()

    logger.error('error')
    logger.warn('warn')
    logger.info('info')
    logger.debug('debug')

    sinon.assert.calledOnce(errorStub)
    sinon.assert.calledWith(errorStub, 'error')
    sinon.assert.notCalled(debugStub)
    sinon.assert.notCalled(infoStub)
    sinon.assert.notCalled(warnStub)
  })

  it('should call the underlying console for warn', () => {
    const logger = new ConsoleLogger({ level: 'warn' })

    logger.error('error')
    logger.warn('warn')
    logger.info('info')
    logger.debug('debug')

    sinon.assert.calledOnce(errorStub)
    sinon.assert.calledWith(errorStub, 'error')
    sinon.assert.calledOnce(warnStub)
    sinon.assert.calledWith(warnStub, 'warn')
    sinon.assert.notCalled(infoStub)
    sinon.assert.notCalled(debugStub)
  })

  it('should call the underlying console for info', () => {
    const logger = new ConsoleLogger({ level: 'info' })

    logger.error('error')
    logger.warn('warn')
    logger.info('info')
    logger.debug('debug')

    sinon.assert.calledOnce(errorStub)
    sinon.assert.calledWith(errorStub, 'error')
    sinon.assert.calledOnce(warnStub)
    sinon.assert.calledWith(warnStub, 'warn')
    sinon.assert.calledOnce(infoStub)
    sinon.assert.calledWith(infoStub, 'info')
    sinon.assert.notCalled(debugStub)
  })

  it('should call the underlying console for debug', () => {
    const logger = new ConsoleLogger({ level: 'debug' })

    logger.error('error')
    logger.warn('warn')
    logger.info('info')
    logger.debug('debug')

    sinon.assert.calledOnce(errorStub)
    sinon.assert.calledWith(errorStub, 'error')
    sinon.assert.calledOnce(warnStub)
    sinon.assert.calledWith(warnStub, 'warn')
    sinon.assert.calledOnce(infoStub)
    sinon.assert.calledWith(infoStub, 'info')
    sinon.assert.calledOnce(debugStub)
    sinon.assert.calledWith(debugStub, 'debug')
  })
})
