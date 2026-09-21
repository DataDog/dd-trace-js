'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')

const log = require('../../../src/log')
const writer = require('../../../src/log/writer')
const logs = require('../../../src/telemetry/logs')
const collector = require('../../../src/telemetry/logs/log-collector')
const { ddBasePath } = require('../../../src/util')

describe('logger telemetry delivery', () => {
  beforeEach(() => {
    collector.reset()
    writer.configure(false, 'debug')
    logs.start({ telemetry: { DD_TELEMETRY_LOG_COLLECTION_ENABLED: true } })
  })

  afterEach(() => {
    logs.stop()
    collector.reset()
    log.configure({})
  })

  it('should collect unformatted messages with debug logging disabled', () => {
    log.error('Request failed: %s', 'customer-secret')

    assert.deepStrictEqual(collector.drain(), [{
      message: 'Request failed: %s',
      level: 'ERROR',
      count: 1,
    }])
  })

  it('should send one record while preserving formatted console output', () => {
    const logger = { error: sinon.spy(), debug: sinon.spy() }
    writer.configure(true, 'debug', logger)
    const cause = new Error('customer-secret')
    cause.stack = `Error: customer-secret\n    at request (${ddBasePath}request.js:1:2)`

    log.error('Request failed: %s', 'customer-value', cause)

    assert.deepStrictEqual(collector.drain(), [{
      message: 'Request failed: %s',
      level: 'ERROR',
      count: 1,
      stack_trace: 'Error: redacted\n    at request (request.js:1:2)',
    }])
    sinon.assert.calledTwice(logger.error)
    assert.strictEqual(logger.error.firstCall.args[0].message, 'Request failed: customer-value')
    assert.strictEqual(logger.error.secondCall.args[0], cause)
  })

  it('should preserve the cause of a lazy message', () => {
    const cause = new TypeError('customer-secret')
    cause.stack = `TypeError: customer-secret\n    at request (${ddBasePath}request.js:1:2)`
    const message = sinon.stub().returns('Request failed')

    log.error(message, cause)

    sinon.assert.calledOnce(message)
    const entries = collector.drain()
    assert.ok(entries)
    assert.strictEqual(entries[0].stack_trace,
      'TypeError: redacted\n    at request (request.js:1:2)')
  })

  it('should redact bare errors', () => {
    const cause = new Error('customer-secret')
    cause.stack = `Error: customer-secret\n    at request (${ddBasePath}request.js:1:2)`
    log.error(cause)

    const entries = collector.drain()
    assert.ok(entries)
    assert.strictEqual(entries[0].message, 'Generic Error')
  })

  it('should respect transmission opt-outs, including lazy messages', () => {
    const configuredLazyMessage = sinon.stub().returns('hidden')
    const noTransmitErrorLazyMessage = sinon.stub().returns('hidden')
    const resolvedOptOutLazyMessage = sinon.stub().returns(['hidden', log.NO_TRANSMIT])
    const errorWithoutTelemetryLazyMessage = sinon.stub().returns('hidden')

    log.error('hidden', log.NO_TRANSMIT)
    log.error(configuredLazyMessage, log.NO_TRANSMIT)
    log.error('hidden', new log.NoTransmitError('secret'))
    log.error(noTransmitErrorLazyMessage, new log.NoTransmitError('secret'))
    log.error(resolvedOptOutLazyMessage)
    log.errorWithoutTelemetry('hidden')
    log.errorWithoutTelemetry(errorWithoutTelemetryLazyMessage)

    sinon.assert.notCalled(configuredLazyMessage)
    sinon.assert.notCalled(noTransmitErrorLazyMessage)
    sinon.assert.calledOnce(resolvedOptOutLazyMessage)
    sinon.assert.notCalled(errorWithoutTelemetryLazyMessage)
    assert.strictEqual(collector.drain(), undefined)
  })

  it('should not collect other levels', () => {
    log.debug('debug')
    log.info('info')
    log.warn('warn')

    assert.strictEqual(collector.drain(), undefined)
  })

  it('should not resolve lazy messages when both logging and telemetry are disabled', () => {
    logs.stop()
    const message = sinon.stub().returns('hidden')

    log.error(message)

    sinon.assert.notCalled(message)
    assert.strictEqual(collector.drain(), undefined)
  })
})
