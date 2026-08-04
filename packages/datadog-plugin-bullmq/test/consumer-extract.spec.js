'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('bullmq consumer _extractDatadog', () => {
  let log
  let BullmqConsumerPlugin

  beforeEach(() => {
    log = { warn: sinon.stub(), error: sinon.stub() }
    BullmqConsumerPlugin = proxyquire('../src/consumer', {
      '../../dd-trace/src/log': log,
    })
  })

  it('returns the carrier when metadata is well-formed JSON with _datadog', () => {
    const job = {
      opts: {
        telemetry: {
          metadata: JSON.stringify({ _datadog: { 'x-datadog-trace-id': '1' }, other: 'kept' }),
        },
      },
    }

    const carrier = BullmqConsumerPlugin.prototype._extractDatadog(job)

    assert.deepStrictEqual(carrier, { 'x-datadog-trace-id': '1' })
    assert.deepStrictEqual(JSON.parse(job.opts.telemetry.metadata), { other: 'kept' })
    sinon.assert.notCalled(log.warn)
  })

  it('warns and does not throw on a malformed metadata JSON string', () => {
    const job = { opts: { telemetry: { metadata: '{not json' } } }

    const result = BullmqConsumerPlugin.prototype._extractDatadog(job)

    assert.strictEqual(result, undefined)
    sinon.assert.calledOnce(log.warn)
    assert.match(log.warn.firstCall.args[0], /malformed telemetry\.metadata/)
  })

  it('returns undefined without warning when metadata is missing', () => {
    const result = BullmqConsumerPlugin.prototype._extractDatadog({ opts: {} })

    assert.strictEqual(result, undefined)
    sinon.assert.notCalled(log.warn)
  })
})
