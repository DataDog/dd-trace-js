'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

require('../src/kafkajs')

const HOOKS = globalThis[Symbol.for('_ddtrace_instrumentations')].kafkajs
const PRODUCER_HOOK = HOOKS.find((entry) => entry.file === 'src/producer/index.js').hook
const INDEX_HOOK = HOOKS.find((entry) => entry.file === 'src/index.js').hook

/**
 * @param {object} options
 * @param {object} [options.cluster] Read for `brokerPool` and
 *   `refreshMetadataIfNecessary`; `undefined` skips clientToCluster registration.
 * @param {Function} [options.originalSend] Returns a thenable; the boundary
 *   forwards send calls to this after cloning the messages.
 * @param {Function} [options.originalSendBatch] Returns a thenable or throws
 *   synchronously; the boundary forwards sendBatch calls to this after cloning
 *   each entry's messages.
 */
function stageProducer ({ cluster, originalSend, originalSendBatch }) {
  const baseCreateProducer = (params) => ({
    send: originalSend,
    sendBatch: originalSendBatch,
    _params: params,
  })
  const wrappedCreateProducer = PRODUCER_HOOK(baseCreateProducer)

  class FakeBaseKafka {
    constructor (options) { this._options = options }

    producer (params) {
      return wrappedCreateProducer({ cluster, ...params })
    }

    // `shimmer.wrap` asserts the method exists on the prototype; the consumer
    // surface stays inert because the tests below only exercise producers.
    consumer () {}
  }

  const WrappedKafka = INDEX_HOOK(FakeBaseKafka)
  const kafka = new WrappedKafka({ brokers: ['127.0.0.1:9092'] })
  return { kafka, producer: kafka.producer() }
}

describe('packages/datadog-instrumentations/src/kafkajs.js', () => {
  const startCh = dc.channel('apm:kafkajs:produce:start')
  const startNoop = () => {}

  beforeEach(() => {
    startCh.subscribe(startNoop)
  })

  afterEach(() => {
    startCh.unsubscribe(startNoop)
  })

  describe('producer.send slow path (no metadata yet)', () => {
    it('runs send after refreshMetadataIfNecessary resolves and forwards the negotiated clusterId', async () => {
      let sendCalls = 0
      // Metadata absent on first call so the boundary takes the slow path,
      // then populated by the time the resolve callback reads it.
      const cluster = {
        brokerPool: { versions: { 0: { maxVersion: 9 } } },
        refreshMetadataIfNecessary: () => {
          cluster.brokerPool.metadata = { clusterId: 'cluster-resolved' }
          return Promise.resolve()
        },
      }

      const seenCtx = []
      const captureStart = (ctx) => seenCtx.push(ctx)
      startCh.subscribe(captureStart)

      const { producer } = stageProducer({
        cluster,
        originalSend: () => { sendCalls++; return Promise.resolve(undefined) },
      })

      try {
        await producer.send({ topic: 'topic', messages: [{ key: 'k', value: 'v' }] })

        assert.equal(sendCalls, 1)
        assert.equal(seenCtx.length, 1)
        assert.equal(seenCtx[0].clusterId, 'cluster-resolved')
        assert.equal(seenCtx[0].disableHeaderInjection, false)
      } finally {
        startCh.unsubscribe(captureStart)
      }
    })

    it('still runs send when refreshMetadataIfNecessary rejects (no clusterId)', async () => {
      let sendCalls = 0
      const cluster = {
        brokerPool: { versions: { 0: { maxVersion: 9 } } },
        refreshMetadataIfNecessary: () => Promise.reject(new Error('boom')),
      }

      const seenCtx = []
      const captureStart = (ctx) => seenCtx.push(ctx)
      startCh.subscribe(captureStart)

      const { producer } = stageProducer({
        cluster,
        originalSend: () => { sendCalls++; return Promise.resolve(undefined) },
      })

      try {
        await producer.send({ topic: 'topic', messages: [{ key: 'k', value: 'v' }] })

        assert.equal(sendCalls, 1)
        assert.equal(seenCtx.length, 1)
        assert.equal(seenCtx[0].clusterId, undefined)
      } finally {
        startCh.unsubscribe(captureStart)
      }
    })

    it('skips refreshMetadataIfNecessary when the cluster does not expose it', async () => {
      let sendCalls = 0
      const cluster = { brokerPool: { versions: { 0: { maxVersion: 9 } } } }

      const { producer } = stageProducer({
        cluster,
        originalSend: () => { sendCalls++; return Promise.resolve(undefined) },
      })

      const result = producer.send({ topic: 'topic', messages: [{ key: 'k', value: 'v' }] })

      assert.equal(typeof result.then, 'function')
      await result
      assert.equal(sendCalls, 1)
    })
  })

  describe('proactive header-support refresh', () => {
    it('disables injection on first send when the broker negotiated Produce <v3', async () => {
      const cluster = {
        brokerPool: {
          metadata: { clusterId: 'old-broker' },
          versions: { 0: { maxVersion: 2 } },
        },
      }

      const seenCtx = []
      const captureStart = (ctx) => seenCtx.push(ctx)
      startCh.subscribe(captureStart)

      const { producer } = stageProducer({
        cluster,
        originalSend: () => Promise.resolve(undefined),
      })

      try {
        await producer.send({ topic: 'topic', messages: [{ key: 'k', value: 'v' }] })

        assert.equal(seenCtx[0].disableHeaderInjection, true)
      } finally {
        startCh.unsubscribe(captureStart)
      }
    })

    it('stops re-running the header-support check after the first disable', async () => {
      let versionLookups = 0
      const cluster = {
        brokerPool: {
          metadata: { clusterId: 'old-broker' },
          versions: new Proxy({ 0: { maxVersion: 2 } }, {
            get (target, key) {
              if (key === '0') versionLookups++
              return target[key]
            },
          }),
        },
      }

      const { producer } = stageProducer({
        cluster,
        originalSend: () => Promise.resolve(undefined),
      })

      await producer.send({ topic: 'topic', messages: [{ key: 'k', value: 'v' }] })
      await producer.send({ topic: 'topic', messages: [{ key: 'k', value: 'v' }] })
      await producer.send({ topic: 'topic', messages: [{ key: 'k', value: 'v' }] })

      assert.equal(versionLookups, 1)
    })
  })

  describe('reactive header-support disable', () => {
    it('disables injection on the next send after KafkaJSProtocolError UNKNOWN', async () => {
      let sendCalls = 0
      const cluster = {
        brokerPool: {
          metadata: { clusterId: 'mixed-version-cluster' },
          versions: { 0: { maxVersion: 9 } },
        },
      }

      const seenCtx = []
      const captureStart = (ctx) => seenCtx.push(ctx)
      startCh.subscribe(captureStart)

      const error = Object.assign(new Error('UNKNOWN_SERVER_ERROR'), {
        name: 'KafkaJSProtocolError',
        type: 'UNKNOWN',
      })

      const originalSend = () => {
        sendCalls++
        return sendCalls === 1 ? Promise.reject(error) : Promise.resolve(undefined)
      }

      const { producer } = stageProducer({ cluster, originalSend })

      try {
        await assert.rejects(
          producer.send({ topic: 't', messages: [{ key: 'k', value: 'v' }] }),
          error
        )
        await producer.send({ topic: 't', messages: [{ key: 'k', value: 'v' }] })

        assert.equal(seenCtx.length, 2)
        assert.equal(seenCtx[0].disableHeaderInjection, false)
        assert.equal(seenCtx[1].disableHeaderInjection, true)
      } finally {
        startCh.unsubscribe(captureStart)
      }
    })

    it('leaves injection enabled on unrelated protocol errors', async () => {
      const cluster = {
        brokerPool: {
          metadata: { clusterId: 'healthy-cluster' },
          versions: { 0: { maxVersion: 9 } },
        },
      }

      const seenCtx = []
      const captureStart = (ctx) => seenCtx.push(ctx)
      startCh.subscribe(captureStart)

      const error = Object.assign(new Error('other'), {
        name: 'KafkaJSProtocolError',
        type: 'TOPIC_AUTHORIZATION_FAILED',
      })

      let sendCalls = 0
      const originalSend = () => {
        sendCalls++
        return sendCalls === 1 ? Promise.reject(error) : Promise.resolve(undefined)
      }

      const { producer } = stageProducer({ cluster, originalSend })

      try {
        await assert.rejects(
          producer.send({ topic: 't', messages: [{ key: 'k', value: 'v' }] }),
          error
        )
        await producer.send({ topic: 't', messages: [{ key: 'k', value: 'v' }] })

        assert.equal(seenCtx.length, 2)
        assert.equal(seenCtx[0].disableHeaderInjection, false)
        assert.equal(seenCtx[1].disableHeaderInjection, false)
      } finally {
        startCh.unsubscribe(captureStart)
      }
    })
  })

  describe('producer.send fast skip', () => {
    it('bypasses the boundary entirely when no subscriber is attached to the produce channel', async () => {
      startCh.unsubscribe(startNoop)
      try {
        let sendCalls = 0
        const { producer } = stageProducer({
          cluster: { brokerPool: { metadata: { clusterId: 'irrelevant' } } },
          originalSend: () => { sendCalls++; return Promise.resolve('passthrough') },
        })

        const result = await producer.send({ topic: 't', messages: [{ key: 'k', value: 'v' }] })

        assert.equal(sendCalls, 1)
        assert.equal(result, 'passthrough')
      } finally {
        startCh.subscribe(startNoop)
      }
    })
  })

  describe('producer.sendBatch', () => {
    const commitCh = dc.channel('apm:kafkajs:produce:commit')
    const errorCh = dc.channel('apm:kafkajs:produce:error')
    const finishCh = dc.channel('apm:kafkajs:produce:finish')

    /**
     * @param {import('dc-polyfill').Channel} channel
     */
    function captureChannel (channel) {
      const events = []
      const handler = (ctx) => events.push(ctx)
      channel.subscribe(handler)
      return { events, unsubscribe: () => channel.unsubscribe(handler) }
    }

    function readyCluster () {
      return {
        brokerPool: {
          metadata: { clusterId: 'cluster-x' },
          versions: { 0: { maxVersion: 9 } },
        },
      }
    }

    it('bypasses the boundary entirely when no subscriber is attached to the produce channel', async () => {
      startCh.unsubscribe(startNoop)
      try {
        let sendBatchCalls = 0
        const { producer } = stageProducer({
          cluster: readyCluster(),
          originalSendBatch: () => { sendBatchCalls++; return Promise.resolve('passthrough') },
        })

        const result = await producer.sendBatch({
          topicMessages: [{ topic: 't', messages: [{ key: 'k', value: 'v' }] }],
        })

        assert.equal(sendBatchCalls, 1)
        assert.equal(result, 'passthrough')
      } finally {
        startCh.subscribe(startNoop)
      }
    })

    it('forwards to originalSendBatch without publishing when topicMessages is missing', async () => {
      let sendBatchCalls = 0
      const start = captureChannel(startCh)

      const { producer } = stageProducer({
        cluster: readyCluster(),
        originalSendBatch: () => { sendBatchCalls++; return Promise.resolve('passthrough') },
      })

      try {
        const result = await producer.sendBatch({})

        assert.equal(sendBatchCalls, 1)
        assert.equal(result, 'passthrough')
        assert.equal(start.events.length, 0)
      } finally {
        start.unsubscribe()
      }
    })

    it('forwards to originalSendBatch without publishing when topicMessages is empty', async () => {
      let sendBatchCalls = 0
      const start = captureChannel(startCh)

      const { producer } = stageProducer({
        cluster: readyCluster(),
        originalSendBatch: () => { sendBatchCalls++; return Promise.resolve(undefined) },
      })

      try {
        await producer.sendBatch({ topicMessages: [] })

        assert.equal(sendBatchCalls, 1)
        assert.equal(start.events.length, 0)
      } finally {
        start.unsubscribe()
      }
    })

    it('forwards the negotiated clusterId on every entry after refreshMetadataIfNecessary resolves', async () => {
      const cluster = {
        brokerPool: { versions: { 0: { maxVersion: 9 } } },
        refreshMetadataIfNecessary: () => {
          cluster.brokerPool.metadata = { clusterId: 'cluster-resolved' }
          return Promise.resolve()
        },
      }

      let sendBatchCalls = 0
      const start = captureChannel(startCh)

      const { producer } = stageProducer({
        cluster,
        originalSendBatch: () => { sendBatchCalls++; return Promise.resolve(undefined) },
      })

      try {
        await producer.sendBatch({
          topicMessages: [
            { topic: 'a', messages: [{ key: 'k', value: 'v' }] },
            { topic: 'b', messages: [{ key: 'k2', value: 'v2' }] },
          ],
        })

        assert.equal(sendBatchCalls, 1)
        assert.equal(start.events.length, 2)
        assert.equal(start.events[0].topic, 'a')
        assert.equal(start.events[0].clusterId, 'cluster-resolved')
        assert.equal(start.events[1].topic, 'b')
        assert.equal(start.events[1].clusterId, 'cluster-resolved')
      } finally {
        start.unsubscribe()
      }
    })

    it('publishes one start+finish ctx per entry and commits once on the first ctx', async () => {
      const start = captureChannel(startCh)
      const commit = captureChannel(commitCh)
      const finish = captureChannel(finishCh)

      const { producer } = stageProducer({
        cluster: readyCluster(),
        originalSendBatch: () => Promise.resolve('batch-result'),
      })

      try {
        await producer.sendBatch({
          topicMessages: [
            { topic: 'a', messages: [{ key: 'k', value: 'v' }] },
            { topic: 'b', messages: [{ key: 'k2', value: 'v2' }] },
          ],
        })

        assert.equal(start.events.length, 2)
        assert.equal(finish.events.length, 2)
        assert.equal(commit.events.length, 1)
        assert.equal(commit.events[0], start.events[0])
        assert.equal(finish.events[0].result, 'batch-result')
        assert.equal(finish.events[1].result, 'batch-result')
      } finally {
        start.unsubscribe()
        commit.unsubscribe()
        finish.unsubscribe()
      }
    })

    it('passes a per-entry ctx with empty messages through when one entry has a non-array messages field', async () => {
      const start = captureChannel(startCh)
      let forwardedArg0
      const { producer } = stageProducer({
        cluster: readyCluster(),
        originalSendBatch: (arg0) => {
          forwardedArg0 = arg0
          return Promise.resolve(undefined)
        },
      })

      const userTopicMessages = [
        { topic: 'a', messages: [{ key: 'k', value: 'v' }] },
        { topic: 'b', messages: 'not-an-array' },
      ]

      try {
        await producer.sendBatch({ topicMessages: userTopicMessages })

        assert.equal(start.events.length, 2)
        assert.equal(start.events[1].topic, 'b')
        assert.deepEqual(start.events[1].messages, [])
        // Invalid entry forwarded verbatim so kafkajs surfaces its own validation error.
        assert.equal(forwardedArg0.topicMessages[1], userTopicMessages[1])
      } finally {
        start.unsubscribe()
      }
    })

    it('leaves args[0] untouched when no entry has a non-empty messages array', async () => {
      const start = captureChannel(startCh)
      let forwardedArg0
      const userArg0 = {
        topicMessages: [
          { topic: 'a', messages: 'not-an-array' },
          { topic: 'b', messages: [] },
        ],
      }
      const { producer } = stageProducer({
        cluster: readyCluster(),
        originalSendBatch: (arg0) => {
          forwardedArg0 = arg0
          return Promise.resolve(undefined)
        },
      })

      try {
        await producer.sendBatch(userArg0)

        assert.equal(start.events.length, 2)
        assert.equal(forwardedArg0, userArg0)
        assert.deepEqual(start.events[0].messages, [])
        assert.deepEqual(start.events[1].messages, [])
      } finally {
        start.unsubscribe()
      }
    })

    it('tags every per-topic ctx with the sync error and rethrows', () => {
      const error = new Error('boom-sync')
      const start = captureChannel(startCh)
      const errorEvents = captureChannel(errorCh)
      const finish = captureChannel(finishCh)

      const { producer } = stageProducer({
        cluster: readyCluster(),
        originalSendBatch: () => { throw error },
      })

      try {
        assert.throws(() => producer.sendBatch({
          topicMessages: [
            { topic: 'a', messages: [{ key: 'k', value: 'v' }] },
            { topic: 'b', messages: [{ key: 'k2', value: 'v2' }] },
          ],
        }), error)

        assert.equal(start.events.length, 2)
        assert.equal(errorEvents.events.length, 2)
        assert.equal(finish.events.length, 2)
        assert.equal(errorEvents.events[0].error, error)
        assert.equal(errorEvents.events[1].error, error)
      } finally {
        start.unsubscribe()
        errorEvents.unsubscribe()
        finish.unsubscribe()
      }
    })

    it('tags every per-topic ctx with the async rejection error', async () => {
      const error = new Error('boom-async')
      const start = captureChannel(startCh)
      const errorEvents = captureChannel(errorCh)
      const finish = captureChannel(finishCh)

      const { producer } = stageProducer({
        cluster: readyCluster(),
        originalSendBatch: () => Promise.reject(error),
      })

      try {
        await assert.rejects(producer.sendBatch({
          topicMessages: [
            { topic: 'a', messages: [{ key: 'k', value: 'v' }] },
            { topic: 'b', messages: [{ key: 'k2', value: 'v2' }] },
          ],
        }), error)

        assert.equal(start.events.length, 2)
        assert.equal(errorEvents.events.length, 2)
        assert.equal(finish.events.length, 2)
        assert.equal(errorEvents.events[1].error, error)
      } finally {
        start.unsubscribe()
        errorEvents.unsubscribe()
        finish.unsubscribe()
      }
    })

    it('disables header injection on the next sendBatch after KafkaJSProtocolError UNKNOWN', async () => {
      const start = captureChannel(startCh)

      const error = Object.assign(new Error('UNKNOWN_SERVER_ERROR'), {
        name: 'KafkaJSProtocolError',
        type: 'UNKNOWN',
      })

      let sendBatchCalls = 0
      const originalSendBatch = () => {
        sendBatchCalls++
        return sendBatchCalls === 1 ? Promise.reject(error) : Promise.resolve(undefined)
      }

      const { producer } = stageProducer({ cluster: readyCluster(), originalSendBatch })

      try {
        await assert.rejects(producer.sendBatch({
          topicMessages: [{ topic: 't', messages: [{ key: 'k', value: 'v' }] }],
        }), error)
        await producer.sendBatch({
          topicMessages: [{ topic: 't', messages: [{ key: 'k', value: 'v' }] }],
        })

        assert.equal(start.events.length, 2)
        assert.equal(start.events[0].disableHeaderInjection, false)
        assert.equal(start.events[1].disableHeaderInjection, true)
      } finally {
        start.unsubscribe()
      }
    })
  })
})
