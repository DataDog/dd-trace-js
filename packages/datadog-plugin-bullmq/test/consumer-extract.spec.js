'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('bullmq consumer propagation extraction', () => {
  let log
  let extractDatadog
  let source

  beforeEach(() => {
    log = { warn: sinon.stub(), error: sinon.stub() }
    source = proxyquire('../src/consumer', {
      '../../dd-trace/src/log': log,
    })
    ;({ extractDatadog } = source)
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

  it('normalizes a job without a carrier for the shared consumer adapter', () => {
    const facts = source.targets[0].start({
      arguments: [{ data: false, queue: { name: 'jobs' } }],
    })

    assert.deepStrictEqual(facts, {
      action: 'processJob',
      body: false,
      carrier: undefined,
      destination: 'jobs',
    })
  })
})
