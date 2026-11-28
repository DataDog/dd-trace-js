'use strict'

const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')

const { channel } = require('dc-polyfill')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')

/**
 * @param {number} start
 * @param {(advanceTo: (value: number) => void) => Promise<unknown>} run
 * @returns {Promise<void>}
 */
async function withFakeNow (start, run) {
  const nowStub = sinon.stub(performance, 'now').returns(start)

  try {
    await run(value => nowStub.returns(value))
  } finally {
    nowStub.restore()
  }
}

/**
 * Runs an operation and verifies that it does not read the clock before returning.
 *
 * @template T
 * @param {() => T} run
 * @returns {T}
 */
function withoutImmediateClockRead (run) {
  const nowStub = sinon.stub(performance, 'now').returns(100)

  try {
    const result = run()
    sinon.assert.notCalled(nowStub)
    return result
  } finally {
    nowStub.restore()
  }
}

/**
 * @template T
 * @param {import('../../..').Tracer} tracer
 * @param {() => Promise<T>} acquire
 * @param {(sql: string) => Promise<Array<{disabled_pool_wait: number}>>} query
 * @param {(connection: T) => unknown} release
 */
async function assertAcquisitionDisabled (tracer, acquire, query, release) {
  const sql = 'SELECT 42 AS disabled_pool_wait'
  const root = 'mariadb-pool-disabled'
  const spanFinish = channel('dd-trace:span:finish')
  const queryStart = channel('apm:mariadb:query:start')
  let acquisitionSpans = 0
  let queryStarts = 0
  const onFinish = span => {
    if (span.context()._name === 'mariadb.pool.acquire') acquisitionSpans++
  }
  const onStart = ctx => {
    if (ctx.sql === sql) queryStarts++
  }
  const trace = agent.assertSomeTraces(traces => {
    const spans = traces[0]
    const querySpan = spans.find(span => span.resource === sql)
    const parent = spans.find(span => span.name === root)
    assert.ok(querySpan)
    assert.ok(parent)
    assert.strictEqual(querySpan.parent_id.toString(), parent.span_id.toString())
    assert.strictEqual(querySpan.metrics['mariadb.pool.wait_time'], undefined)
  }, { spanResourceMatch: /^SELECT 42 AS disabled_pool_wait$/ })

  tracer.use('mariadb', { poolAcquire: false })
  spanFinish.subscribe(onFinish)
  queryStart.subscribe(onStart)
  try {
    const operation = tracer.trace(root, async () => {
      const holder = await acquire()
      const checkout = (async () => {
        const next = await acquire()
        const starts = queryStarts
        await release(next)
        return starts
      })()
      const clock = sinon.spy(performance, 'now')
      let result
      let clockReads
      try {
        result = query(sql)
        clockReads = clock.callCount
      } finally {
        clock.restore()
      }

      const [startsAtCheckout, rows] = await Promise.all([checkout, result, release(holder)])
      assert.strictEqual(clockReads, 0)
      assert.strictEqual(startsAtCheckout, 0)
      assert.strictEqual(queryStarts, 1)
      assert.strictEqual(acquisitionSpans, 0)
      assert.strictEqual(rows[0].disabled_pool_wait, 42)
    })

    await Promise.all([trace, operation])
  } finally {
    queryStart.unsubscribe(onStart)
    spanFinish.unsubscribe(onFinish)
    tracer.use('mariadb', {})
  }
}

module.exports = { assertAcquisitionDisabled, withFakeNow, withoutImmediateClockRead }
