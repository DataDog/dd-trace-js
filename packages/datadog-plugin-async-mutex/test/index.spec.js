'use strict'

const assert = require('node:assert/strict')

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/plugin-test-helpers')

createIntegrationTestSuite('async-mutex', 'async-mutex', {}, (meta) => {
  const { agent } = meta

  describe('Mutex', () => {
    it('traces an uncontended acquire', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'async-mutex.acquire',
        resource: 'acquire',
        meta: {
          component: 'async-mutex',
        },
        metrics: {
          'async_mutex.contended': 0,
        },
      })

      const mutex = new meta.mod.Mutex()
      const release = await mutex.acquire()
      release()

      return traceAssertion
    })

    it('marks an acquire that had to queue behind a holder', async () => {
      const mutex = new meta.mod.Mutex()
      const release = await mutex.acquire()

      const traceAssertion = agent.assertSomeTraces(traces => {
        const span = traces.flat().find(candidate => candidate.metrics['async_mutex.contended'] === 1)
        assert.ok(span, 'expected a span marked as contended')
        assert.equal(span.name, 'async-mutex.acquire')
      })

      const queued = mutex.acquire()
      release()
      ;(await queued)()

      return traceAssertion
    })

    it('closes the span only once the lock is granted', async () => {
      const mutex = new meta.mod.Mutex()
      const release = await mutex.acquire()

      const HOLD_MS = 60
      const traceAssertion = agent.assertSomeTraces(traces => {
        const span = traces.flat().find(candidate => candidate.metrics['async_mutex.contended'] === 1)
        assert.ok(span, 'expected a span marked as contended')
        // The span has to cover the wait, not just the synchronous call that started it.
        assert.ok(
          span.duration >= BigInt(HOLD_MS - 5) * 1_000_000n,
          `expected the span to span the wait, got ${span.duration}ns`
        )
      })

      const queued = mutex.acquire()
      setTimeout(release, HOLD_MS)
      ;(await queued)()

      return traceAssertion
    })

    it('traces runExclusive through the same acquire', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'async-mutex.acquire',
        meta: { component: 'async-mutex' },
      })

      const mutex = new meta.mod.Mutex()
      assert.equal(await mutex.runExclusive(() => 'done'), 'done')

      return traceAssertion
    })
  })

  describe('Semaphore', () => {
    it('records a non-default weight', async () => {
      const traceAssertion = agent.assertFirstTraceSpan({
        name: 'async-mutex.acquire',
        metrics: {
          'async_mutex.weight': 2,
        },
      })

      const semaphore = new meta.mod.Semaphore(3)
      const [, release] = await semaphore.acquire(2)
      release()

      return traceAssertion
    })

    it('preserves the ticket contract', async () => {
      const semaphore = new meta.mod.Semaphore(2)
      const [firstValue, releaseFirst] = await semaphore.acquire()
      const [secondValue, releaseSecond] = await semaphore.acquire()

      assert.equal(firstValue, 2)
      assert.equal(secondValue, 1)
      assert.equal(semaphore.getValue(), 0)

      releaseFirst()
      releaseSecond()
      assert.equal(semaphore.getValue(), 2)
    })

    it('reports a cancelled acquire as an error', async () => {
      const semaphore = new meta.mod.Semaphore(1)
      const [, release] = await semaphore.acquire()

      const traceAssertion = agent.assertSomeTraces(traces => {
        const span = traces.flat().find(candidate => candidate.error === 1)
        assert.ok(span, 'expected an errored span')
        assert.equal(span.name, 'async-mutex.acquire')
        assert.equal(span.meta['error.message'], 'request for lock canceled')
      })

      const queued = semaphore.acquire()
      semaphore.cancel()
      await assert.rejects(queued)
      release()

      return traceAssertion
    })
  })
})
