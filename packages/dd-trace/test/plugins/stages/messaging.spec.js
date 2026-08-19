'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('messaging stage', () => {
  let createMessagingStage
  let DsmPathwayCodec
  let getMessageSize

  beforeEach(() => {
    DsmPathwayCodec = { encode: sinon.stub() }
    getMessageSize = sinon.stub().returns(42)
    ;({ createMessagingStage } = proxyquire('../../../src/plugins/stages/messaging', {
      '../../datastreams': { DsmPathwayCodec, getMessageSize },
    }))
  })

  /**
   * Build the frame surface the stage is allowed to use.
   *
   * @param {{dsmEnabled?: boolean, data?: Record<string, unknown>, pathway?: object}} [options]
   * @returns {object}
   */
  function createFrame ({ dsmEnabled = true, data = {}, pathway = { hash: Buffer.alloc(8) } } = {}) {
    return {
      config: { dsmEnabled },
      data,
      correlation: { inject: sinon.stub() },
      dataStreams: {
        decode: sinon.stub(),
        setCheckpoint: sinon.stub().returns(pathway),
      },
    }
  }

  const outbound = {
    direction: 'out',
    system: 'testmq',
    topic: frame => frame.data.topic,
    messages: frame => frame.data.messages,
    carrier: () => ({}),
  }

  describe('declaration validation', () => {
    it('rejects a missing or unknown direction', () => {
      assert.throws(() => createMessagingStage({ ...outbound, direction: undefined }), {
        name: 'TypeError',
        message: /"in" or "out" direction/,
      })
      assert.throws(() => createMessagingStage({ ...outbound, direction: 'inbound' }), {
        name: 'TypeError',
        message: /"in" or "out" direction/,
      })
    })

    it('rejects a missing or empty system', () => {
      assert.throws(() => createMessagingStage({ ...outbound, system: undefined }), /non-empty system/)
      assert.throws(() => createMessagingStage({ ...outbound, system: '' }), /non-empty system/)
    })

    it('rejects non-function accessors', () => {
      assert.throws(() => createMessagingStage({ ...outbound, topic: 'jobs' }), /topic accessor/)
      assert.throws(() => createMessagingStage({ ...outbound, messages: [] }), /messages accessor/)
      assert.throws(() => createMessagingStage({ ...outbound, carrier: {} }), /carrier accessor/)
      assert.throws(() => createMessagingStage({ ...outbound, commit: 'later' }), /commit function/)
      assert.throws(() => createMessagingStage({ ...outbound, payload: 'body' }), /payload accessor/)
    })

    it('accepts a declaration without commit or payload', () => {
      const stage = createMessagingStage(outbound)

      assert.strictEqual(stage.name, 'messaging')
      assert.deepStrictEqual(stage.requires, ['tracing'])
    })
  })

  describe('outbound', () => {
    it('injects correlation and encodes the pathway into one shared carrier', () => {
      const commit = sinon.stub()
      const stage = createMessagingStage({ ...outbound, commit, payload: message => message.body })
      const frame = createFrame({ data: { topic: 'jobs', messages: [{ body: 'payload' }] } })

      stage.start(frame)

      const carrier = frame.correlation.inject.firstCall.args[1]
      assert.strictEqual(frame.correlation.inject.firstCall.args[0], 'text_map')
      assert.strictEqual(DsmPathwayCodec.encode.firstCall.args[1], carrier)
      assert.strictEqual(commit.firstCall.args[1], carrier)
      assert.strictEqual(commit.firstCall.args[0], frame.data.messages[0])
      assert.strictEqual(commit.firstCall.args[2], frame)
      sinon.assert.callOrder(frame.correlation.inject, frame.dataStreams.setCheckpoint, commit)
    })

    it('builds the outbound edge tags from the declared direction, topic, and system', () => {
      const stage = createMessagingStage({ ...outbound, payload: message => message.body })
      const frame = createFrame({ data: { topic: 'jobs', messages: [{ body: 'real' }] } })

      stage.start(frame)

      sinon.assert.calledOnceWithExactly(
        frame.dataStreams.setCheckpoint,
        ['direction:out', 'topic:jobs', 'type:testmq'],
        42
      )
    })

    it('sizes each payload and skips sizing entirely for a falsy payload', () => {
      const stage = createMessagingStage({ ...outbound, payload: message => message.body })
      const frame = createFrame({ data: { topic: 'jobs', messages: [{ body: false }, { body: 'real' }] } })

      stage.start(frame)

      sinon.assert.calledOnceWithExactly(getMessageSize, 'real')
      assert.deepStrictEqual(
        frame.dataStreams.setCheckpoint.args.map(([, size]) => size),
        [0, 42]
      )
    })

    it('reports a zero payload size when no payload accessor is declared', () => {
      const stage = createMessagingStage(outbound)
      const frame = createFrame({ data: { topic: 'jobs', messages: [{}] } })

      stage.start(frame)

      sinon.assert.notCalled(getMessageSize)
      assert.strictEqual(frame.dataStreams.setCheckpoint.firstCall.args[1], 0)
    })

    it('propagates every message in a batch and skips absent entries', () => {
      const commit = sinon.stub()
      const stage = createMessagingStage({ ...outbound, commit })
      const frame = createFrame({ data: { topic: 'jobs', messages: [{ id: 1 }, undefined, null, { id: 2 }] } })

      stage.start(frame)

      assert.strictEqual(frame.correlation.inject.callCount, 2)
      assert.strictEqual(frame.dataStreams.setCheckpoint.callCount, 2)
      assert.deepStrictEqual(commit.args.map(([message]) => message.id), [1, 2])
    })

    it('gives each message in a batch its own carrier', () => {
      const stage = createMessagingStage(outbound)
      const frame = createFrame({ data: { topic: 'jobs', messages: [{}, {}] } })

      stage.start(frame)

      assert.notStrictEqual(frame.correlation.inject.firstCall.args[1], frame.correlation.inject.secondCall.args[1])
    })

    it('still propagates but records no checkpoint when data streams are disabled', () => {
      const commit = sinon.stub()
      const topic = sinon.stub().returns('jobs')
      const stage = createMessagingStage({ ...outbound, topic, commit })
      const frame = createFrame({ dsmEnabled: false, data: { messages: [{}] } })

      stage.start(frame)

      sinon.assert.calledOnce(frame.correlation.inject)
      sinon.assert.calledOnce(commit)
      sinon.assert.notCalled(frame.dataStreams.setCheckpoint)
      sinon.assert.notCalled(DsmPathwayCodec.encode)
      sinon.assert.notCalled(topic)
    })

    it('records a checkpoint but writes nothing when the library exposes no carrier', () => {
      const commit = sinon.stub()
      const stage = createMessagingStage({ ...outbound, carrier: () => undefined, commit })
      const frame = createFrame({ data: { topic: 'jobs', messages: [{}] } })

      stage.start(frame)

      sinon.assert.calledOnceWithExactly(
        frame.dataStreams.setCheckpoint,
        ['direction:out', 'topic:jobs', 'type:testmq'],
        0
      )
      sinon.assert.notCalled(frame.correlation.inject)
      sinon.assert.notCalled(DsmPathwayCodec.encode)
      sinon.assert.notCalled(commit)
    })

    it('does nothing when there is no carrier and data streams are disabled', () => {
      const commit = sinon.stub()
      const stage = createMessagingStage({ ...outbound, carrier: () => undefined, commit })
      const frame = createFrame({ dsmEnabled: false, data: { messages: [{}] } })

      stage.start(frame)

      sinon.assert.notCalled(frame.dataStreams.setCheckpoint)
      sinon.assert.notCalled(frame.correlation.inject)
      sinon.assert.notCalled(commit)
    })

    it('does nothing when the operation handles no messages', () => {
      const stage = createMessagingStage(outbound)

      for (const messages of [undefined, []]) {
        const frame = createFrame({ data: { topic: 'jobs', messages } })
        stage.start(frame)

        sinon.assert.notCalled(frame.correlation.inject)
        sinon.assert.notCalled(frame.dataStreams.setCheckpoint)
      }
    })
  })

  describe('inbound', () => {
    const inbound = {
      direction: 'in',
      system: 'testmq',
      topic: frame => frame.data.topic,
      messages: frame => frame.data.messages,
      carrier: message => message.carrier,
    }

    it('decodes each incoming pathway before recording its checkpoint', () => {
      const stage = createMessagingStage({ ...inbound, payload: message => message.body })
      const carrier = { 'dd-pathway-ctx-base64': 'abc' }
      const frame = createFrame({ data: { topic: 'jobs', messages: [{ carrier, body: 'real' }] } })

      stage.start(frame)

      sinon.assert.calledOnceWithExactly(frame.dataStreams.decode, carrier)
      sinon.assert.calledOnceWithExactly(
        frame.dataStreams.setCheckpoint,
        ['direction:in', 'topic:jobs', 'type:testmq'],
        42
      )
      sinon.assert.callOrder(frame.dataStreams.decode, frame.dataStreams.setCheckpoint)
    })

    it('decodes an absent carrier so an inherited pathway is not extended', () => {
      const stage = createMessagingStage(inbound)
      const frame = createFrame({ data: { topic: 'jobs', messages: [{ carrier: undefined }] } })

      stage.start(frame)

      sinon.assert.calledOnceWithExactly(frame.dataStreams.decode, undefined)
      sinon.assert.calledOnce(frame.dataStreams.setCheckpoint)
    })

    it('never injects or encodes on the inbound path', () => {
      const stage = createMessagingStage(inbound)
      const frame = createFrame({ data: { topic: 'jobs', messages: [{ carrier: {} }] } })

      stage.start(frame)

      sinon.assert.notCalled(frame.correlation.inject)
      sinon.assert.notCalled(DsmPathwayCodec.encode)
    })

    it('does nothing when data streams are disabled', () => {
      const messages = sinon.stub().returns([{ carrier: {} }])
      const stage = createMessagingStage({ ...inbound, messages })
      const frame = createFrame({ dsmEnabled: false, data: { topic: 'jobs' } })

      stage.start(frame)

      sinon.assert.notCalled(messages)
      sinon.assert.notCalled(frame.dataStreams.decode)
      sinon.assert.notCalled(frame.dataStreams.setCheckpoint)
    })

    it('skips absent messages', () => {
      const stage = createMessagingStage(inbound)
      const frame = createFrame({ data: { topic: 'jobs', messages: [undefined] } })

      stage.start(frame)

      sinon.assert.notCalled(frame.dataStreams.decode)
      sinon.assert.notCalled(frame.dataStreams.setCheckpoint)
    })

    it('does nothing when the operation handles no messages', () => {
      const stage = createMessagingStage(inbound)

      for (const messages of [undefined, []]) {
        const frame = createFrame({ data: { topic: 'jobs', messages } })
        stage.start(frame)

        sinon.assert.notCalled(frame.dataStreams.decode)
        sinon.assert.notCalled(frame.dataStreams.setCheckpoint)
      }
    })
  })
})
