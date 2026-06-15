'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  let tracer
  let knex
  let client

  describe('knex', () => {
    // The acquire span is added on the `>=2` hook that also wraps `Client.raw`.
    withVersions('knex', 'knex', '>=2', version => {
      before(async () => {
        tracer = await agent.load('knex')
      })

      after(() => agent.close({ ritmReset: false }))

      beforeEach(() => {
        knex = require(`../../../versions/knex@${version}`).get()
        client = knex({
          client: 'sqlite3',
          connection: { filename: ':memory:' },
          useNullAsDefault: true,
          // A single connection forces concurrent callers to wait, and no minimum keeps the pool from
          // pre-warming, so the test exercises the wait path deterministically.
          pool: { min: 0, max: 1 },
        })
      })

      afterEach(() => client.destroy())

      it('opens a knex.pool.acquire span while a caller waits for a connection', async () => {
        const parent = tracer.startSpan('knex-parent')

        const tracePromise = agent.assertSomeTraces(traces => {
          const acquireSpan = traces[0].find(span => span.name === 'knex.pool.acquire')

          assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
          assert.strictEqual(acquireSpan.service, 'test-knex')
          assert.strictEqual(acquireSpan.resource, 'knex.pool.acquire')
          assert.strictEqual(acquireSpan.type, 'sql')
          assert.strictEqual(acquireSpan.meta['db.type'], 'sqlite')
          assert.strictEqual(acquireSpan.parent_id.toString(), parent.context().toSpanId())
          assert.strictEqual(typeof acquireSpan.metrics['knex.pool.wait_time'], 'number')
          assert.ok(acquireSpan.metrics['knex.pool.wait_time'] >= 0)
        }, { spanResourceMatch: /^knex\.pool\.acquire$/ })

        await tracer.scope().activate(parent, async () => {
          await Promise.all([
            client.raw('SELECT 1 AS one'),
            client.raw('SELECT 2 AS two'),
            client.raw('SELECT 3 AS three'),
          ])
          parent.finish()
        })

        await tracePromise
      })

      it('does not open a span when an idle connection is available', async () => {
        // Warm the pool so a connection sits on the free list for the next acquire.
        await client.raw('SELECT 1 AS one')

        const parent = tracer.startSpan('knex-warm-parent')

        const tracePromise = agent.assertSomeTraces(traces => {
          assert.ok(
            !traces[0].some(span => span.name === 'knex.pool.acquire'),
            `unexpected acquire span: ${inspect(traces[0].map(span => span.name))}`
          )
        }, { spanResourceMatch: /^knex-warm-parent$/ })

        await tracer.scope().activate(parent, async () => {
          await client.raw('SELECT 2 AS two')
          parent.finish()
        })

        await tracePromise
      })
    })
  })
})
