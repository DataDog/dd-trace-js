'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('bullmq producer telemetry metadata parsing', () => {
  let log
  let parseTelemetryMetadata

  beforeEach(() => {
    log = { warn: sinon.stub(), error: sinon.stub() }
    ;({ parseTelemetryMetadata } = proxyquire('../src/producer', {
      '../../dd-trace/src/log': log,
    }))
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
})
