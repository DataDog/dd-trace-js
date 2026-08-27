'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('bullmq producer telemetry metadata parsing', () => {
  let log
  let parseTelemetryMetadata
  let source

  beforeEach(() => {
    log = { warn: sinon.stub(), error: sinon.stub() }
    source = proxyquire('../src/producer', {
      '../../dd-trace/src/log': log,
    })
    ;({ parseTelemetryMetadata } = source)
  })

  it('preserves well-formed customer metadata', () => {
    assert.deepStrictEqual(parseTelemetryMetadata(JSON.stringify({ keep: 'me' })), { keep: 'me' })
    sinon.assert.notCalled(log.warn)
  })

  it('returns an empty carrier and warns for malformed customer metadata', () => {
    assert.deepStrictEqual(parseTelemetryMetadata('{not json'), {})
    sinon.assert.calledOnce(log.warn)
    assert.match(log.warn.firstCall.args[0], /malformed telemetry\.metadata/)
  })

  it('returns an empty carrier without warning when metadata is missing', () => {
    assert.deepStrictEqual(parseTelemetryMetadata(undefined), {})
    sinon.assert.notCalled(log.warn)
  })

  it('returns an empty carrier for valid JSON that is not a metadata object', () => {
    assert.deepStrictEqual(parseTelemetryMetadata('null'), {})
    assert.deepStrictEqual(parseTelemetryMetadata('[]'), {})
    sinon.assert.notCalled(log.warn)
  })

  it('writes processor carriers for bulk jobs with falsy data', () => {
    const target = source.targets[1]
    const job = { data: false, opts: { telemetry: { metadata: '{}' } } }
    const context = { arguments: [[job]], self: { name: 'jobs' } }
    const facts = target.start(context)
    const carrier = { pathway: 'encoded' }

    target.updateSource(context, facts, { carriers: [{ carrier, index: 0 }] })

    assert.strictEqual(facts.messages[0].body, false)
    assert.deepStrictEqual(JSON.parse(job.opts.telemetry.metadata), { _datadog: carrier })
    assert.strictEqual(job.opts.telemetry.omitContext, true)
  })

  it('preserves customer metadata when writing a Queue.add carrier', () => {
    const target = source.targets[0]
    const context = {
      arguments: ['job', { id: 1 }, { telemetry: { metadata: JSON.stringify({ customer: true }) } }],
      self: { name: 'jobs' },
    }
    const facts = target.start(context)

    target.updateSource(context, facts, { carriers: [{ carrier: { trace: '1' }, index: 0 }] })

    assert.deepStrictEqual(JSON.parse(context.arguments[2].telemetry.metadata), {
      _datadog: { trace: '1' },
      customer: true,
    })
  })

  it('adds a mutable Queue.add options argument only when propagation writes back', () => {
    const target = source.targets[0]
    const context = { arguments: ['job', { id: 1 }], self: { name: 'jobs' } }
    const facts = target.start(context)

    assert.strictEqual(context.arguments.length, 2)
    target.updateSource(context, facts, { carriers: [{ carrier: { trace: '1' }, index: 0 }] })

    assert.strictEqual(context.arguments.length, 3)
    assert.strictEqual(context.arguments[2].telemetry.omitContext, true)
  })
})
