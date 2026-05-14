'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')

const { afterEach, describe, it } = require('mocha')

const { wrapPostgres } = require('../src/postgres')

const startCh = dc.channel('apm:pg:query:start')
const finishCh = dc.channel('apm:pg:query:finish')
const errorCh = dc.channel('apm:pg:query:error')

const subscriptions = []

function subscribe (channel, handler) {
  channel.subscribe(handler)
  subscriptions.push({ channel, handler })
}

function createPostgres (queryImpl, unsafeImpl) {
  return function postgres (options) {
    function sql (strings, ...values) {
      return queryImpl(strings, values)
    }

    sql.options = options
    sql.unsafe = function (query) {
      return unsafeImpl(query)
    }

    return sql
  }
}

afterEach(() => {
  while (subscriptions.length > 0) {
    const { channel, handler } = subscriptions.pop()
    channel.unsubscribe(handler)
  }
})

describe('postgres instrumentation', () => {
  it('publishes start and finish for template queries', async () => {
    let startCtx
    let finishCtx

    subscribe(startCh, ctx => { startCtx = ctx })
    subscribe(finishCh, ctx => { finishCtx = ctx })

    const postgres = createPostgres(
      () => Promise.resolve('ok'),
      query => Promise.resolve(query)
    )
    const wrappedPostgres = wrapPostgres(postgres)
    const sql = wrappedPostgres({
      host: '127.0.0.1',
      port: 5432,
      database: 'postgres',
      username: 'postgres',
    })

    await sql`SELECT ${1}::int`

    assert.strictEqual(startCtx.originalText, 'SELECT $1::int')
    assert.deepStrictEqual(startCtx.params, {
      host: '127.0.0.1',
      port: 5432,
      database: 'postgres',
      user: 'postgres',
    })
    assert.strictEqual(finishCtx, startCtx)
  })

  it('uses injected query for unsafe calls', async () => {
    let unsafeQuery

    subscribe(startCh, ctx => {
      ctx.injected = '/*trace*/ SELECT 1'
    })

    const postgres = createPostgres(
      () => Promise.resolve('ok'),
      query => {
        unsafeQuery = query
        return Promise.resolve(query)
      }
    )
    const sql = wrapPostgres(postgres)({})

    await sql.unsafe('SELECT 1')

    assert.strictEqual(unsafeQuery, '/*trace*/ SELECT 1')
  })

  it('publishes error channel on promise rejection', async () => {
    const expectedError = new Error('query failed')
    let errorCtx

    subscribe(startCh, () => {})
    subscribe(errorCh, ctx => { errorCtx = ctx })

    const postgres = createPostgres(
      () => Promise.reject(expectedError),
      query => Promise.resolve(query)
    )
    const sql = wrapPostgres(postgres)({})

    await assert.rejects(sql`SELECT ${1}`, expectedError)

    assert.strictEqual(errorCtx.error, expectedError)
    assert.strictEqual(errorCtx.originalText, 'SELECT $1')
  })
})