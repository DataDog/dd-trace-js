'use strict'

const t = require('tap')
require('../../setup/core')

/* eslint-disable no-console */

const sinon = require('sinon')

t.test('loggers/console', t => {
  let ConsoleLogger

  t.beforeEach(() => {
    sinon.stub(console, 'debug')
    sinon.stub(console, 'info')
    sinon.stub(console, 'warn')
    sinon.stub(console, 'error')

    ConsoleLogger = require('../../../src/profiling/loggers/console').ConsoleLogger
  })

  t.afterEach(() => {
    console.debug.restore()
    console.info.restore()
    console.warn.restore()
    console.error.restore()
  })

  t.test('should call the underlying console for error', t => {
    const logger = new ConsoleLogger()

    logger.error('error')
    logger.warn('warn')
    logger.info('info')
    logger.debug('debug')

    sinon.assert.calledOnce(console.error)
    sinon.assert.calledWith(console.error, 'error')
    sinon.assert.notCalled(console.debug)
    sinon.assert.notCalled(console.info)
    sinon.assert.notCalled(console.warn)
    t.end()
  })

  t.test('should call the underlying console for warn', t => {
    const logger = new ConsoleLogger({ level: 'warn' })

    logger.error('error')
    logger.warn('warn')
    logger.info('info')
    logger.debug('debug')

    sinon.assert.calledOnce(console.error)
    sinon.assert.calledWith(console.error, 'error')
    sinon.assert.calledOnce(console.warn)
    sinon.assert.calledWith(console.warn, 'warn')
    sinon.assert.notCalled(console.info)
    sinon.assert.notCalled(console.debug)
    t.end()
  })

  t.test('should call the underlying console for info', t => {
    const logger = new ConsoleLogger({ level: 'info' })

    logger.error('error')
    logger.warn('warn')
    logger.info('info')
    logger.debug('debug')

    sinon.assert.calledOnce(console.error)
    sinon.assert.calledWith(console.error, 'error')
    sinon.assert.calledOnce(console.warn)
    sinon.assert.calledWith(console.warn, 'warn')
    sinon.assert.calledOnce(console.info)
    sinon.assert.calledWith(console.info, 'info')
    sinon.assert.notCalled(console.debug)
    t.end()
  })

  t.test('should call the underlying console for debug', t => {
    const logger = new ConsoleLogger({ level: 'debug' })

    logger.error('error')
    logger.warn('warn')
    logger.info('info')
    logger.debug('debug')

    sinon.assert.calledOnce(console.error)
    sinon.assert.calledWith(console.error, 'error')
    sinon.assert.calledOnce(console.warn)
    sinon.assert.calledWith(console.warn, 'warn')
    sinon.assert.calledOnce(console.info)
    sinon.assert.calledWith(console.info, 'info')
    sinon.assert.calledOnce(console.debug)
    sinon.assert.calledWith(console.debug, 'debug')
    t.end()
  })
  t.end()
})
