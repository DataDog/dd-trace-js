'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

const BullmqPlugin = require('../src')

const DSM_KEY = 'dd-pathway-ctx-base64'
const TRACE_KEY = 'x-datadog-trace-id'

describe('bullmq pipeline stages', () => {
  let addedTags
  let checkpoints
  let decoded
  let plugin
  let tracer
  let tracerConfig

  beforeEach(() => {
    addedTags = []
    checkpoints = []
    decoded = []

    const spanContext = { getTag: () => undefined, getTags: () => ({}), setTag: () => {} }
    const span = {
      addTags: tags => addedTags.push(tags),
      context: () => spanContext,
      finish: () => {},
      setTag: () => {},
    }

    tracer = {
      _nomenclature: { serviceName: () => 'test' },
      _service: 'test',
      createSpanContext: () => ({ toSpanId: () => '2', toTraceId: () => '1' }),
      decodeDataStreamsContext: carrier => {
        decoded.push(carrier)
      },
      extract: () => null,
      inject: (context, format, carrier) => {
        carrier[TRACE_KEY] = '1'
      },
      setCheckpoint: (edgeTags, _span, payloadSize) => {
        checkpoints.push({ edgeTags, payloadSize })
        return { hash: Buffer.alloc(8), pathwayStartNs: 1e6, edgeStartNs: 2e6 }
      },
      startSpan: () => span,
    }

    tracerConfig = { spanComputePeerService: false }
  })

  afterEach(() => {
    plugin?.configure(false)
  })

  /**
   * Load the plugin against the tracer double.
   *
   * @param {Record<string, unknown>} [config]
   * @returns {void}
   */
  function load (config) {
    plugin = new BullmqPlugin(tracer, tracerConfig)
    plugin.configure({ enabled: true, dsmEnabled: true, hooks: {}, ...config })
  }

  /**
   * Drive one Orchestrion target through its full async lifecycle.
   *
   * @param {string} target
   * @param {object} invocation
   * @returns {Promise<string>}
   */
  function invoke (target, invocation) {
    return dc.tracingChannel(`orchestrion:bullmq:${target}`)
      .tracePromise(() => Promise.resolve('library-result'), invocation)
  }

  /**
   * Read the Datadog carrier the producer persisted into BullMQ telemetry metadata.
   *
   * @param {object} opts
   * @returns {{metadata: Record<string, unknown>, carrier: Record<string, string>}}
   */
  function readCarrier (opts) {
    const metadata = JSON.parse(opts.telemetry.metadata)
    return { metadata, carrier: metadata._datadog }
  }

  describe('Queue.add', () => {
    it('writes propagation and the DSM pathway into a single carrier', async () => {
      load()
      const opts = { telemetry: { metadata: JSON.stringify({ keep: 'me' }) } }

      await invoke('Queue_add', { arguments: ['job', { body: 1 }, opts], self: { name: 'queue' } })

      const { metadata, carrier } = readCarrier(opts)
      assert.strictEqual(carrier[TRACE_KEY], '1')
      assert.strictEqual(typeof carrier[DSM_KEY], 'string')
      assert.strictEqual(metadata.keep, 'me')
      assert.strictEqual(opts.telemetry.omitContext, true)
    })

    it('persists telemetry metadata exactly once per message', async () => {
      load()
      let telemetry
      let writes = 0
      const opts = {
        get telemetry () {
          return telemetry
        },
        set telemetry (value) {
          writes++
          telemetry = value
        },
      }

      await invoke('Queue_add', { arguments: ['job', { body: 1 }, opts], self: { name: 'queue' } })

      assert.strictEqual(writes, 1)
    })

    it('records one outbound checkpoint tagged with the queue name', async () => {
      load()

      await invoke('Queue_add', { arguments: ['job', { body: 1 }, {}], self: { name: 'queue' } })

      assert.deepStrictEqual(checkpoints.map(({ edgeTags }) => edgeTags), [
        ['direction:out', 'topic:queue', 'type:bullmq'],
      ])
    })

    it('creates a mutable options argument when the caller omitted one', async () => {
      load()
      const invocation = { arguments: ['job', { body: 1 }], self: { name: 'queue' } }

      await invoke('Queue_add', invocation)

      assert.strictEqual(typeof invocation.arguments[2].telemetry.metadata, 'string')
    })

    it('propagates without checkpointing when data streams are disabled', async () => {
      load({ dsmEnabled: false })
      const opts = {}

      await invoke('Queue_add', { arguments: ['job', { body: 1 }, opts], self: { name: 'queue' } })

      const { carrier } = readCarrier(opts)
      assert.strictEqual(carrier[TRACE_KEY], '1')
      assert.strictEqual(carrier[DSM_KEY], undefined)
      assert.deepStrictEqual(checkpoints, [])
    })

    it('adds code-origin tags through the producer stage', async () => {
      tracerConfig.codeOriginForSpans = { enabled: true, experimental: { exit_spans: { enabled: true } } }
      load({ dsmEnabled: false })

      const result = await invoke('Queue_add', { arguments: ['job', {}, {}], self: { name: 'queue' } })

      assert.strictEqual(result, 'library-result')
      assert.ok(addedTags.some(tags => tags['_dd.code_origin.type'] === 'exit'))
    })
  })

  describe('Queue.addBulk', () => {
    it('gives every job its own carrier and checkpoint', async () => {
      load()
      const jobs = [
        { name: 'a', data: { body: 1 } },
        { name: 'b', data: { body: 2 }, opts: { telemetry: { metadata: JSON.stringify({ keep: 'me' }) } } },
      ]

      await invoke('Queue_addBulk', { arguments: [jobs], self: { name: 'queue' } })

      const first = readCarrier(jobs[0].opts)
      const second = readCarrier(jobs[1].opts)
      assert.strictEqual(first.carrier[TRACE_KEY], '1')
      assert.strictEqual(typeof first.carrier[DSM_KEY], 'string')
      assert.strictEqual(second.carrier[TRACE_KEY], '1')
      assert.strictEqual(second.metadata.keep, 'me')
      assert.deepStrictEqual(checkpoints.map(({ edgeTags }) => edgeTags), [
        ['direction:out', 'topic:queue', 'type:bullmq'],
        ['direction:out', 'topic:queue', 'type:bullmq'],
      ])
    })

    it('skips absent entries in the batch', async () => {
      load()
      const jobs = [undefined, { name: 'b', data: { body: 2 } }]

      await invoke('Queue_addBulk', { arguments: [jobs], self: { name: 'queue' } })

      assert.strictEqual(checkpoints.length, 1)
      assert.strictEqual(readCarrier(jobs[1].opts).carrier[TRACE_KEY], '1')
    })
  })

  describe('FlowProducer.add', () => {
    it('writes the carrier into the flow options and checkpoints its queue', async () => {
      load()
      const flow = { name: 'job', queueName: 'flow-queue', data: { body: 1 } }

      await invoke('FlowProducer_add', { arguments: [flow] })

      const { carrier } = readCarrier(flow.opts)
      assert.strictEqual(carrier[TRACE_KEY], '1')
      assert.strictEqual(typeof carrier[DSM_KEY], 'string')
      assert.deepStrictEqual(checkpoints.map(({ edgeTags }) => edgeTags), [
        ['direction:out', 'topic:flow-queue', 'type:bullmq'],
      ])
    })
  })

  describe('Worker.callProcessJob', () => {
    it('decodes the incoming pathway and records an inbound checkpoint', async () => {
      load()
      const carrier = { [TRACE_KEY]: '1', [DSM_KEY]: 'abc' }
      const job = {
        data: { body: 1 },
        queueName: 'queue',
        opts: { telemetry: { metadata: JSON.stringify({ _datadog: carrier, keep: 'me' }) } },
      }

      await invoke('Worker_callProcessJob', { arguments: [job] })

      assert.deepStrictEqual(decoded, [carrier])
      assert.deepStrictEqual(checkpoints.map(({ edgeTags }) => edgeTags), [
        ['direction:in', 'topic:queue', 'type:bullmq'],
      ])
      assert.deepStrictEqual(JSON.parse(job.opts.telemetry.metadata), { keep: 'me' })
    })

    it('decodes an absent carrier so an inherited pathway is not extended', async () => {
      load()
      const job = { data: { body: 1 }, queueName: 'queue' }

      await invoke('Worker_callProcessJob', { arguments: [job] })

      assert.deepStrictEqual(decoded, [undefined])
      assert.strictEqual(checkpoints.length, 1)
    })

    it('records no checkpoint when data streams are disabled', async () => {
      load({ dsmEnabled: false })

      await invoke('Worker_callProcessJob', { arguments: [{ data: { body: 1 }, queueName: 'queue' }] })

      assert.deepStrictEqual(decoded, [])
      assert.deepStrictEqual(checkpoints, [])
    })
  })

  it('does not let a failing commit break the library call', async () => {
    load()
    const job = {
      name: 'a',
      data: { body: 1 },
      get opts () {
        throw new Error('library rejected the options read')
      },
    }

    const result = await invoke('Queue_addBulk', { arguments: [[job]], self: { name: 'queue' } })

    assert.strictEqual(result, 'library-result')
    assert.strictEqual(checkpoints.length, 1)
  })
})
