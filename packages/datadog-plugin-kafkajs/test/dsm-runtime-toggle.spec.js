'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

require('../../dd-trace/test/setup/core')
const KafkajsProducerPlugin = require('../src/producer')
const KafkajsConsumerPlugin = require('../src/consumer')
const KafkajsBatchConsumerPlugin = require('../src/batch-consumer')

const dsmContext = {
  hash: Buffer.from('e858292fd15a41e4', 'hex'),
  pathwayStartNs: 1e12,
  edgeStartNs: 1e12,
}

// Broker-free: hooks are driven directly, as the instrumentation would through diagnostic channels.
describe('Plugin kafkajs DSM hooks while DSM is toggled at runtime', () => {
  let tracer

  beforeEach(() => {
    tracer = {
      setCheckpoint: sinon.stub().returns(dsmContext),
      setOffset: sinon.stub(),
      decodeDataStreamsContext: sinon.stub(),
      extract: sinon.stub(),
      scope: () => ({ active: () => null }),
    }
  })

  function createProducer (dsmEnabled) {
    const plugin = new KafkajsProducerPlugin(tracer, {})
    plugin.configure({ enabled: true, dsmEnabled })
    return plugin
  }

  function createConsumer (dsmEnabled) {
    const plugin = new KafkajsConsumerPlugin(tracer, {})
    plugin.configure({ enabled: true, dsmEnabled })
    return plugin
  }

  describe('producer', () => {
    function produceContext () {
      return {
        topic: 't',
        messages: [{ value: 'v', headers: {} }],
        currentStore: { span: {} },
      }
    }

    it('leaves the messages untouched while inactive', () => {
      const plugin = createProducer(false)
      const ctx = produceContext()

      plugin.start(ctx)
      plugin.commit({ result: [{ topicName: 't', partition: 0, baseOffset: '1' }] })

      assert.deepStrictEqual(ctx.messages, [{ value: 'v', headers: {} }])
      sinon.assert.notCalled(tracer.setCheckpoint)
      sinon.assert.notCalled(tracer.setOffset)
    })

    it('does not throw on malformed input while inactive', () => {
      const plugin = createProducer(false)

      plugin.start({})
      plugin.commit(undefined)
    })

    it('uses the live state once the plugin is reconfigured', () => {
      const plugin = createProducer(false)
      plugin.configure({ enabled: true, dsmEnabled: true })
      const ctx = produceContext()

      plugin.start(ctx)

      sinon.assert.calledOnce(tracer.setCheckpoint)
      assert.ok('dd-pathway-ctx-base64' in ctx.messages[0].headers)
    })

    it('stops injecting once reconfigured as inactive again', () => {
      const plugin = createProducer(true)
      plugin.configure({ enabled: true, dsmEnabled: false })
      const ctx = produceContext()

      plugin.start(ctx)

      sinon.assert.notCalled(tracer.setCheckpoint)
      assert.deepStrictEqual(ctx.messages[0].headers, {})
    })
  })

  describe('consumer', () => {
    const consumeContext = () => ({
      topic: 't',
      groupId: 'g',
      message: { headers: { 'dd-pathway-ctx-base64': 'abc' } },
      currentStore: { span: {} },
    })

    it('does not decode or checkpoint while inactive', () => {
      const plugin = createConsumer(false)

      plugin.start(consumeContext())
      plugin.commit([{ groupId: 'g', partition: 0, offset: 1, topic: 't' }])

      sinon.assert.notCalled(tracer.decodeDataStreamsContext)
      sinon.assert.notCalled(tracer.setCheckpoint)
      sinon.assert.notCalled(tracer.setOffset)
    })

    it('checkpoints once reconfigured as active', () => {
      const plugin = createConsumer(false)
      plugin.configure({ enabled: true, dsmEnabled: true })

      plugin.start(consumeContext())

      sinon.assert.calledOnce(tracer.decodeDataStreamsContext)
      sinon.assert.calledOnce(tracer.setCheckpoint)
    })
  })

  describe('batch consumer', () => {
    function consumeBatch (dsmEnabled) {
      const plugin = new KafkajsBatchConsumerPlugin(tracer, {})
      plugin.configure({ enabled: true, dsmEnabled })
      plugin.startSpan = sinon.stub().returns({ addLink: sinon.stub() })
      plugin.bindStart({
        topic: 't',
        groupId: 'g',
        partition: 0,
        messages: [{ value: 'v', headers: { 'dd-pathway-ctx-base64': 'abc' } }],
        currentStore: {},
      })
    }

    it('does not checkpoint while inactive', () => {
      consumeBatch(false)

      sinon.assert.notCalled(tracer.decodeDataStreamsContext)
      sinon.assert.notCalled(tracer.setCheckpoint)
    })

    it('checkpoints while active', () => {
      consumeBatch(true)

      sinon.assert.calledOnce(tracer.decodeDataStreamsContext)
      sinon.assert.calledOnce(tracer.setCheckpoint)
    })
  })
})
