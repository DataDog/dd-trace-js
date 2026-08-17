'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('bullmq producer telemetry metadata parsing', () => {
  let log
  let parseTelemetryMetadata
  let operations
  let DsmPathwayCodec
  let getMessageSize

  beforeEach(() => {
    log = { warn: sinon.stub(), error: sinon.stub() }
    DsmPathwayCodec = { encode: sinon.stub() }
    getMessageSize = sinon.stub()
    operations = proxyquire('../src/producer', {
      '../../dd-trace/src/log': log,
      '../../dd-trace/src/datastreams': { DsmPathwayCodec, getMessageSize },
    })
    ;({ parseTelemetryMetadata } = operations)
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

  it('creates bulk DSM checkpoints for jobs with falsy data', () => {
    const pathway = { hash: Buffer.alloc(8) }
    const dataStreams = { setCheckpoint: sinon.stub().returns(pathway) }
    const job = { data: false, opts: { telemetry: { metadata: '{}' } } }

    operations[1].stages[1].start({
      config: { dsmEnabled: true },
      data: { jobs: [job], queueName: 'jobs' },
      dataStreams,
    })

    sinon.assert.calledOnceWithExactly(dataStreams.setCheckpoint, [
      'direction:out',
      'topic:jobs',
      'type:bullmq',
    ], 0)
    sinon.assert.notCalled(getMessageSize)
    sinon.assert.calledOnce(DsmPathwayCodec.encode)
  })
})
