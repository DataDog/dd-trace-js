'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const sinon = require('sinon')

require('../../dd-trace/test/setup/core')
const KafkajsConsumerPlugin = require('../src/consumer')
const KafkajsProducerPlugin = require('../src/producer')

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
