'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('bullmq consumer propagation extraction', () => {
  let log
  let extractDatadog
  let operation

  beforeEach(() => {
    log = { warn: sinon.stub(), error: sinon.stub() }
    operation = proxyquire('../src/consumer', {
      '../../dd-trace/src/log': log,
    })
    ;({ extractDatadog } = operation)
  })

  it('returns the carrier when metadata is well-formed JSON with _datadog', () => {
    const job = {
      opts: {
        telemetry: {
          metadata: JSON.stringify({ _datadog: { 'x-datadog-trace-id': '1' }, other: 'kept' }),
        },
      },
    }

    const carrier = extractDatadog(job)

    assert.deepStrictEqual(carrier, { 'x-datadog-trace-id': '1' })
    assert.deepStrictEqual(JSON.parse(job.opts.telemetry.metadata), { other: 'kept' })
    sinon.assert.notCalled(log.warn)
  })

  it('warns and does not throw on a malformed metadata JSON string', () => {
    const job = { opts: { telemetry: { metadata: '{not json' } } }

    const result = extractDatadog(job)

    assert.strictEqual(result, undefined)
    sinon.assert.calledOnce(log.warn)
    assert.match(log.warn.firstCall.args[0], /malformed telemetry\.metadata/)
  })

  it('returns undefined without warning when metadata is missing', () => {
    const result = extractDatadog({ opts: {} })

    assert.strictEqual(result, undefined)
    sinon.assert.notCalled(log.warn)
  })

  it('clears inherited DSM context when a job has no carrier', () => {
    const dataStreams = {
      decode: sinon.stub(),
      setCheckpoint: sinon.stub(),
    }

    operation.stages[0].start({
      config: { dsmEnabled: true },
      data: { job: {}, queueName: 'jobs', carrier: undefined },
      dataStreams,
    })

    sinon.assert.calledOnceWithExactly(dataStreams.decode, undefined)
    sinon.assert.calledOnceWithExactly(dataStreams.setCheckpoint, [
      'direction:in',
      'topic:jobs',
      'type:bullmq',
    ], 0)
  })
})
