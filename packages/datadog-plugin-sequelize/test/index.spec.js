'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  let tracer
  let Sequelize
  let sequelize

  describe('sequelize', () => {
    // The acquire span relies on sequelize-pool's `available`, which sequelize adopted in v5.
    withVersions('sequelize', 'sequelize', '>=5', version => {
      before(async () => {
        tracer = await agent.load('sequelize')
      })

      after(() => agent.close({ ritmReset: false }))

      beforeEach(() => {
        Sequelize = require(`../../../versions/sequelize@${version}`).get().Sequelize
        sequelize = new Sequelize({
          dialect: 'sqlite',
          storage: ':memory:',
          logging: false,
          // A single connection forces concurrent callers to wait, and no minimum keeps the pool from
          // pre-warming, so the test exercises the wait path deterministically.
          pool: { min: 0, max: 1 },
        })
      })

      afterEach(() => sequelize.close())

      it('opens a sequelize.pool.acquire span while a caller waits for a connection', async () => {
        const parent = tracer.startSpan('sequelize-parent')

        const tracePromise = agent.assertSomeTraces(traces => {
          const acquireSpan = traces[0].find(span => span.name === 'sequelize.pool.acquire')

          assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
          assert.strictEqual(acquireSpan.service, 'test-sequelize')
          assert.strictEqual(acquireSpan.resource, 'sequelize.pool.acquire')
          assert.strictEqual(acquireSpan.type, 'sql')
          assert.strictEqual(acquireSpan.meta['db.type'], 'sqlite')
          assert.strictEqual(acquireSpan.parent_id.toString(), parent.context().toSpanId())
          assert.strictEqual(typeof acquireSpan.metrics['sequelize.pool.wait_time'], 'number')
          assert.ok(acquireSpan.metrics['sequelize.pool.wait_time'] >= 0)
        }, { spanResourceMatch: /^sequelize\.pool\.acquire$/ })

        await tracer.scope().activate(parent, async () => {
          await Promise.all([
            sequelize.query('SELECT 1 AS one'),
            sequelize.query('SELECT 2 AS two'),
            sequelize.query('SELECT 3 AS three'),
          ])
          parent.finish()
        })

        await tracePromise
      })

      it('does not open a span when an idle connection is available', async () => {
        // Warm the pool so a connection sits in the available list for the next acquire.
        await sequelize.query('SELECT 1 AS one')

        const parent = tracer.startSpan('sequelize-warm-parent')

        const tracePromise = agent.assertSomeTraces(traces => {
          assert.ok(
            !traces[0].some(span => span.name === 'sequelize.pool.acquire'),
            `unexpected acquire span: ${inspect(traces[0].map(span => span.name))}`
          )
        }, { spanResourceMatch: /^sequelize-warm-parent$/ })

        await tracer.scope().activate(parent, async () => {
          await sequelize.query('SELECT 2 AS two')
          parent.finish()
        })

        await tracePromise
      })
    })
  })
})
