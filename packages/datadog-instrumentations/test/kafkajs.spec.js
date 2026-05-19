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
 * @param {Function} options.originalSend Returns a thenable; the boundary
 *   forwards send calls to this after cloning the messages.
 */
function stageProducer ({ cluster, originalSend }) {
  const baseCreateProducer = (params) => ({ send: originalSend, _params: params })
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
})
