'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')

const { describe, it } = require('mocha')

const Kinesis = require('../src/services/kinesis')

const STREAM_NAME = 'test-stream'

/**
 * @param {(carrier: Record<string, string>|undefined) => void} decodeDataStreamsContext
 * @returns {Kinesis}
 */
function buildPlugin (decodeDataStreamsContext) {
  const tracer = { decodeDataStreamsContext, setCheckpoint: () => undefined }
  const plugin = new Kinesis(tracer, {})
  plugin.config = { dsmEnabled: true }
  return plugin
}

/**
 * @param {object} [data] Record payload; omit for a record the producer never instrumented.
 */
function record (data = { id: 1 }) {
  return { Data: Buffer.from(JSON.stringify(data)) }
}

describe('Kinesis plugin responseExtractDSMContext', () => {
  it('decodes every record of a mixed batch, so one without a context starts a new pathway', () => {
    const decoded = []
    const plugin = buildPlugin(carrier => { decoded.push(carrier) })
    const datadog = { 'dd-pathway-ctx-base64': 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' }

    plugin.responseExtractDSMContext(
      'getRecords',
      {},
      { Records: [record({ _datadog: datadog }), record(), { Data: Buffer.from('not json') }] },
      null,
      { streamName: STREAM_NAME }
    )

    assert.deepStrictEqual(decoded, [datadog, undefined, undefined])
  })
})
