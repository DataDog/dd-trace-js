'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

require('../../dd-trace/test/setup/core')
const KafkajsConsumerPlugin = require('../src/consumer')
const KafkajsProducerPlugin = require('../src/producer')

describe('kafkajs producer finish', () => {
  /**
   * Build a fake span whose setTag records the tags applied.
   * Also stubs the inherited finish so super.finish() doesn't run real tracer logic.
   */
  function makeFinishHarness () {
    const tags = {}
    const span = { setTag: (k, v) => { tags[k] = v } }
    const plugin = new KafkajsProducerPlugin({}, {})
    plugin.config = { dsmEnabled: false }
    const parentFinish = sinon.stub(Object.getPrototypeOf(KafkajsProducerPlugin.prototype), 'finish')
    return { plugin, span, tags, restore: () => parentFinish.restore() }
  }

  it('sorts multi-partition offsets by partition and emits them as strings', () => {
    const { plugin, span, tags, restore } = makeFinishHarness()
    try {
      plugin.finish({
        currentStore: { span },
        messages: [{ value: 'a' }, { value: 'b' }, { value: 'c' }],
        result: [
          { topicName: 't', partition: 2, baseOffset: '20' },
          { topicName: 't', partition: 0, baseOffset: '5' },
          { topicName: 't', partition: 1, baseOffset: '12' },
        ],
      })
    } finally {
      restore()
    }
    assert.equal(tags['kafka.messages.offsets'], JSON.stringify([
      { partition: 0, start_offset: '5' },
      { partition: 1, start_offset: '12' },
      { partition: 2, start_offset: '20' },
    ]))
    // Multi-partition batch: no flat tags.
    assert.equal(tags['kafka.partition'], undefined)
    assert.equal(tags['kafka.message.offset'], undefined)
  })

  it('preserves offsets larger than Number.MAX_SAFE_INTEGER without precision loss', () => {
    const { plugin, span, tags, restore } = makeFinishHarness()
    // 2^53 + 7 — round-trips through Number as 2^53 + 8, so Number() would corrupt it.
    const hugeOffset = '9007199254740999'
    try {
      plugin.finish({
        currentStore: { span },
        messages: [{ value: 'one' }],
        result: [{ topicName: 't', partition: 0, baseOffset: hugeOffset }],
      })
    } finally {
      restore()
    }
    assert.equal(tags['kafka.messages.offsets'], JSON.stringify([{ partition: 0, start_offset: hugeOffset }]))
    assert.equal(tags['kafka.message.offset'], hugeOffset)
    assert.equal(tags['kafka.partition'], 0)
  })

  it('emits a literal-zero baseOffset (?? guards against falsy coercion)', () => {
    const { plugin, span, tags, restore } = makeFinishHarness()
    try {
      plugin.finish({
        currentStore: { span },
        messages: [{ value: 'one' }],
        result: [{ topicName: 't', partition: 0, baseOffset: 0 }],
      })
    } finally {
      restore()
    }
    assert.equal(tags['kafka.messages.offsets'], JSON.stringify([{ partition: 0, start_offset: '0' }]))
    assert.equal(tags['kafka.message.offset'], '0')
  })
})

describe('kafkajs commit walk', () => {
  it('consumer forwards every transformed offset to tracer.setOffset when DSM is enabled', () => {
    const setOffset = sinon.spy()
    const plugin = new KafkajsConsumerPlugin({ setOffset }, {})
    plugin.config = { dsmEnabled: true }

    plugin.commit([
      { groupId: 'g1', topic: 't1', partition: 0, offset: '10' },
      { groupId: 'g2', topic: 't2', partition: 1, offset: '20', clusterId: 'c1' },
    ])

    sinon.assert.calledTwice(setOffset)
    assert.deepStrictEqual(setOffset.firstCall.args[0], {
      partition: 0,
      topic: 't1',
      type: 'kafka_commit',
      offset: 10,
      consumer_group: 'g1',
    })
    assert.deepStrictEqual(setOffset.secondCall.args[0], {
      partition: 1,
      topic: 't2',
      type: 'kafka_commit',
      offset: 20,
      consumer_group: 'g2',
      kafka_cluster_id: 'c1',
    })
  })

  it('producer forwards every transformed offset to tracer.setOffset when DSM is enabled', () => {
    const setOffset = sinon.spy()
    const plugin = new KafkajsProducerPlugin({ setOffset }, {})
    plugin.config = { dsmEnabled: true }

    plugin.commit({
      result: [
        { topicName: 't1', partition: 0, offset: '5' },
        { topicName: 't2', partition: 1, baseOffset: '7' },
      ],
      clusterId: 'c1',
    })

    sinon.assert.calledTwice(setOffset)
    assert.deepStrictEqual(setOffset.firstCall.args[0], {
      type: 'kafka_produce',
      partition: 0,
      offset: 5,
      topic: 't1',
      kafka_cluster_id: 'c1',
    })
    assert.deepStrictEqual(setOffset.secondCall.args[0], {
      type: 'kafka_produce',
      partition: 1,
      offset: 7,
      topic: 't2',
      kafka_cluster_id: 'c1',
    })
  })
})
