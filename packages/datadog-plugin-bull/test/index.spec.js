'use strict'

const assert = require('node:assert/strict')

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')

const redis = { host: '127.0.0.1', port: 6379 }

createIntegrationTestSuite('bull', 'bull', {
  category: 'messaging',
}, (meta) => {
  const { agent } = meta
  let queue

  beforeEach(async () => {
    const Queue = meta.mod
    queue = new Queue(`test-queue-${Date.now()}`, { redis })
    await queue.isReady()
  })

  afterEach(() => queue.close())

  describe('Queue#add', () => {
    it('creates a producer span', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'bull.add',
        resource: queue.name,
        meta: {
          'span.kind': 'producer',
          'messaging.system': 'bull',
          'messaging.destination.name': queue.name,
          'messaging.operation': 'publish',
          component: 'bull',
        },
      })

      await queue.add('test-job', { message: 'hello' })

      return traceAssertion
    })

    it('stores the trace context in the job options without touching the data', async () => {
      const job = await queue.add('test-job', { message: 'hello' }, { attempts: 3 })
      const stored = await queue.getJob(job.id)

      assert.deepEqual(stored.data, { message: 'hello' })
      assert.equal(stored.opts.attempts, 3)
      assert.equal(typeof stored.opts._datadog['x-datadog-trace-id'], 'string')
    })

    it('does not change the options object passed by the caller', async () => {
      const opts = { attempts: 2 }
      await queue.add('test-job', { message: 'hello' }, opts)

      assert.deepEqual(opts, { attempts: 2 })
    })

    it('creates a producer span for a job added without a name', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'bull.add',
        resource: queue.name,
      })

      const job = await queue.add({ message: 'unnamed' })
      assert.deepEqual(job.data, { message: 'unnamed' })

      return traceAssertion
    })

    it('creates a producer span for a repeatable job', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'bull.add',
        resource: queue.name,
        meta: {
          'span.kind': 'producer',
          component: 'bull',
        },
      })

      await queue.add('repeat-job', { message: 'tick' }, { repeat: { every: 60_000 } })

      return traceAssertion
    })
  })

  describe('Queue#addBulk', () => {
    it('creates one producer span for the batch', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'bull.addBulk',
        resource: queue.name,
        meta: {
          'span.kind': 'producer',
          'messaging.system': 'bull',
          'messaging.destination.name': queue.name,
          component: 'bull',
        },
        metrics: {
          'messaging.batch.message_count': 2,
        },
      })

      const jobs = await queue.addBulk([
        { name: 'bulk-1', data: { n: 1 } },
        { name: 'bulk-2', data: { n: 2 } },
      ])
      assert.equal(jobs.length, 2)

      return traceAssertion
    })
  })

  describe('Queue#process', () => {
    it('creates a consumer span that is a child of the producer span', async () => {
      const spans = []
      const traceAssertion = agent.assertSomeTraces(traces => {
        spans.push(...traces.flat())
        const producer = spans.find(span => span.name === 'bull.add')
        const consumer = spans.find(span => span.name === 'bull.process')

        assert.ok(producer, 'producer span not found')
        assert.ok(consumer, 'consumer span not found')
        assert.equal(consumer.trace_id.toString(), producer.trace_id.toString())
        assert.equal(consumer.parent_id.toString(), producer.span_id.toString())
        assert.equal(consumer.resource, queue.name)
        assert.equal(consumer.meta['span.kind'], 'consumer')
        assert.equal(consumer.meta['messaging.system'], 'bull')
        assert.equal(consumer.meta['messaging.operation'], 'process')
        assert.equal(consumer.meta.component, 'bull')
      })

      queue.process(async () => 'done')
      const job = await queue.add({ message: 'hello' })
      assert.equal(await job.finished(), 'done')

      return traceAssertion
    })

    it('links every job of a batch to the batch span', async () => {
      const spans = []
      const traceAssertion = agent.assertSomeTraces(traces => {
        spans.push(...traces.flat())
        const producer = spans.find(span => span.name === 'bull.addBulk')
        const consumers = spans.filter(span => span.name === 'bull.process')

        assert.ok(producer, 'producer span not found')
        assert.equal(consumers.length, 2)
        for (const consumer of consumers) {
          assert.equal(consumer.parent_id.toString(), producer.span_id.toString())
        }
      })

      queue.process(async () => {})
      const jobs = await queue.addBulk([{ data: { n: 1 } }, { data: { n: 2 } }])
      await Promise.all(jobs.map(job => job.finished()))

      return traceAssertion
    })

    it('tags the consumer span with the handler error and still fails the job', async () => {
      const traceAssertion = agent.assertSomeTraces(traces => {
        const consumer = traces.flat().find(span => span.name === 'bull.process')

        assert.ok(consumer, 'consumer span not found')
        assert.equal(consumer.error, 1)
        assert.equal(consumer.meta['error.type'], 'Error')
        assert.equal(consumer.meta['error.message'], 'job failed')
        assert.equal(typeof consumer.meta['error.stack'], 'string')
      })

      const failed = new Promise(resolve => queue.once('failed', (job, error) => resolve(error)))
      queue.process(async () => { throw new Error('job failed') })
      const job = await queue.add({ message: 'hello' })

      await assert.rejects(job.finished(), { message: 'job failed' })
      assert.equal((await failed).message, 'job failed')

      return traceAssertion
    })
  })
})
