'use strict'

const assert = require('node:assert/strict')
const { Buffer } = require('node:buffer')

const { describe, it } = require('mocha')

const Kinesis = require('../src/services/kinesis')

const STREAM_NAME = 'my-stream'
const STREAM_ARN = `arn:aws:kinesis:us-east-1:123456789012:stream/${STREAM_NAME}`

/**
 * @param {string[][]} checkpoints Receives the edge tags of every DSM checkpoint.
 * @returns {Kinesis}
 */
function buildPlugin (checkpoints = []) {
  const tracer = {
    inject: () => undefined,
    /**
     * @param {string[]} tags
     */
    setCheckpoint (tags) {
      checkpoints.push(tags)
    },
  }
  const plugin = new Kinesis(tracer, {})
  plugin.config = { dsmEnabled: true, batchPropagationEnabled: false }
  return plugin
}

/**
 * @returns {{ Data: Buffer, PartitionKey: string }}
 */
function record () {
  return { Data: Buffer.from(JSON.stringify({ id: 1 })), PartitionKey: 'key' }
}

describe('Kinesis plugin stream identification', () => {
  describe('generateTags', () => {
    it('tags the stream name without an ARN tag when only StreamName is set', () => {
      const tags = buildPlugin().generateTags({ StreamName: STREAM_NAME }, 'putRecord')

      assert.deepStrictEqual(tags, {
        'resource.name': `putRecord ${STREAM_NAME}`,
        'aws.kinesis.stream_name': STREAM_NAME,
        'messaging.system': 'aws_kinesis',
        streamname: STREAM_NAME,
      })
    })

    it('tags the ARN and derives the stream name when only StreamARN is set', () => {
      const tags = buildPlugin().generateTags({ StreamARN: STREAM_ARN }, 'putRecord')

      assert.deepStrictEqual(tags, {
        'resource.name': `putRecord ${STREAM_NAME}`,
        'aws.kinesis.stream_name': STREAM_NAME,
        'messaging.system': 'aws_kinesis',
        streamname: STREAM_NAME,
        'aws.stream.arn': STREAM_ARN,
      })
    })

    it('prefers StreamName over the ARN suffix when both are set', () => {
      const tags = buildPlugin().generateTags({ StreamName: 'other-stream', StreamARN: STREAM_ARN }, 'getRecords')
      assert.ok(tags)

      assert.strictEqual(tags.streamname, 'other-stream')
      assert.strictEqual(tags['aws.kinesis.stream_name'], 'other-stream')
      assert.strictEqual(tags['aws.stream.arn'], STREAM_ARN)
    })

    it('returns no tags when the request names no stream', () => {
      const plugin = buildPlugin()

      assert.strictEqual(plugin.generateTags({ ShardIterator: 'iterator' }, 'getRecords'), undefined)
      assert.strictEqual(plugin.generateTags(undefined, 'getRecords'), undefined)
    })
  })

  describe('requestInject DSM topic', () => {
    for (const operation of ['putRecord', 'putRecords']) {
      /**
       * @param {{ StreamName?: string, StreamARN?: string }} streamParams
       * @returns {string[][]}
       */
      function inject (streamParams) {
        const checkpoints = []
        const params = operation === 'putRecord'
          ? { ...streamParams, ...record() }
          : { ...streamParams, Records: [record()] }
        buildPlugin(checkpoints).requestInject(null, { operation, params })
        return checkpoints
      }

      it(`uses the stream name derived from StreamARN for ${operation}`, () => {
        assert.deepStrictEqual(inject({ StreamARN: STREAM_ARN }), [
          ['direction:out', `topic:${STREAM_NAME}`, 'type:kinesis'],
        ])
      })

      it(`keeps the StreamName topic when both are set for ${operation}`, () => {
        assert.deepStrictEqual(inject({ StreamName: 'other-stream', StreamARN: STREAM_ARN }), [
          ['direction:out', 'topic:other-stream', 'type:kinesis'],
        ])
      })
    }
  })
})
