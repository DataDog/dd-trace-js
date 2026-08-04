'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const POSTGRES_TARGET = {
  database: 'postgres',
  host: '127.0.0.1',
  max: 1,
  password: 'postgres',
  port: 5432,
  user: 'postgres',
}

const queryChannel = dc.tracingChannel('orchestrion:postgres:query')

describe('postgres instrumentation', () => {
  withVersions('postgres', 'postgres', version => {
    let events
    let sql
    let subscriptions

    before(() => agent.load('postgres'))

    beforeEach(() => {
      events = []
      subscriptions = {
        start: ctx => events.push({ name: 'start', query: ctx.query, options: ctx.options }),
        asyncStart: query => events.push({ name: 'asyncStart', query }),
        asyncEnd: query => events.push({ name: 'asyncEnd', query }),
        error: ctx => events.push({ name: 'error', query: ctx.query, error: ctx.error }),
      }
      queryChannel.subscribe(subscriptions)

      const postgres = require(`../../../versions/postgres@${version}`).get()
      sql = postgres(POSTGRES_TARGET)
    })

    afterEach(() => {
      queryChannel.unsubscribe(subscriptions)
      return sql.end({ timeout: 0 })
    })

    after(() => agent.close())

    it('publishes one lifecycle around a real lazy query', async () => {
      const query = sql`SELECT ${42}::int AS value`
      const result = await query
      const queryEvents = events.filter(({ query: eventQuery }) => eventQuery === query)

      assert.strictEqual(result[0].value, 42)
      assert.deepStrictEqual(queryEvents.map(({ name }) => name), ['start', 'asyncStart', 'asyncEnd'])
      assert.strictEqual(queryEvents[1].query.string, 'SELECT $1::int AS value')
      assert.deepStrictEqual(queryEvents[0].options.host, ['127.0.0.1'])
      assert.deepStrictEqual(queryEvents[0].options.port, [5432])
    })

    it('publishes the real database error before ending the lifecycle', async () => {
      const query = sql.unsafe('INVALID SQL')
      let queryError

      await assert.rejects(query, error => {
        queryError = error
        return error.name === 'PostgresError' && /syntax error/.test(error.message)
      })
      const queryEvents = events.filter(({ query: eventQuery }) => eventQuery === query)

      assert.deepStrictEqual(queryEvents.map(({ name }) => name), ['start', 'asyncStart', 'error', 'asyncEnd'])
      assert.strictEqual(queryEvents[2].error, queryError)
    })

    it('publishes one settlement when the initial query fails while building', async () => {
      const query = sql`SELECT ${undefined}`
      let queryError

      await assert.rejects(query, error => {
        queryError = error
        return /Undefined values are not allowed/.test(error.message)
      })
      const queryEvents = events.filter(({ query: eventQuery }) => eventQuery === query)

      assert.deepStrictEqual(queryEvents.map(({ name }) => name), ['start', 'error', 'asyncEnd'])
      assert.strictEqual(queryEvents[1].error, queryError)
    })
  })
})
