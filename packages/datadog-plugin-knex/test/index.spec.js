'use strict'

const assert = require('node:assert/strict')

const semver = require('semver')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const databases = [
  {
    client: 'cockroachdb',
    connection: { database: 'postgres', host: '127.0.0.1', password: 'postgres', user: 'postgres' },
    driver: 'pg',
    metric: 'db.pool.wait_time_ms',
    querySpan: 'pg.query',
  },
  {
    client: 'mysql',
    connection: { database: 'db', host: '127.0.0.1', user: 'root' },
    metric: 'mysql.pool.wait_time',
    querySpan: 'mysql.query',
  },
  {
    client: 'mysql2',
    connection: { database: 'db', host: '127.0.0.1', user: 'root' },
    metric: 'mysql2.pool.wait_time',
    querySpan: 'mysql.query',
  },
  {
    client: 'pg',
    connection: { database: 'postgres', host: '127.0.0.1', password: 'postgres', user: 'postgres' },
    metric: 'db.pool.wait_time_ms',
    querySpan: 'pg.query',
  },
  {
    client: 'redshift',
    connection: { database: 'postgres', host: '127.0.0.1', password: 'postgres', user: 'postgres' },
    driver: 'pg',
    metric: 'db.pool.wait_time_ms',
    querySpan: 'pg.query',
  },
]

describe('knex pool acquisition', () => {
  for (const database of databases) {
    describe(`with ${database.client}`, () => {
      let tracer

      withVersions('knex', 'knex', '>=2', (version, _, resolvedVersion) => {
        let knex
        let client
        let driver
        let nativePool

        before(async () => {
          tracer = await agent.load(database.driver ?? database.client)
        })

        after(() => agent.close({ ritmReset: false }))

        beforeEach(() => {
          const versionPackage = require(`../../../versions/knex@${version}`)
          knex = versionPackage.get()
          driver = versionPackage.get(database.driver ?? database.client)
          nativePool = undefined
          client = knex({
            client: database.client,
            connection: { ...database.connection },
            pool: { min: 0, max: 1 },
          })
        })

        afterEach(async () => {
          await client.destroy()
          if (nativePool !== undefined) await closeNativePool(nativePool, database.driver ?? database.client)
        })

        it('adds a pool wait tag to a query instead of creating an acquire span', async () => {
          const connection = await client.client.acquireConnection()
          const parent = tracer.startSpan('knex-query-parent')
          const tracePromise = assertQueryWaitTrace('knex-query-parent', database)

          const queryPromise = tracer.scope().activate(parent, () => Promise.resolve(client.raw('SELECT 1 AS one')))
          await Promise.all([
            queryPromise,
            waitForPendingAcquire(client.client.pool)
              .finally(() => client.client.releaseConnection(connection)),
          ])
          parent.finish()

          await tracePromise
        })

        it('adds a pool wait tag to the first transaction query', async () => {
          const connection = await client.client.acquireConnection()
          const parent = tracer.startSpan('knex-transaction-parent')
          const tracePromise = assertQueryWaitTrace('knex-transaction-parent', database)

          const transactionPromise = tracer.scope().activate(parent, () => client.transaction(async transaction => {
            await transaction.raw('SELECT 1 AS one')
          }))
          await Promise.all([
            transactionPromise,
            waitForPendingAcquire(client.client.pool)
              .finally(() => client.client.releaseConnection(connection)),
          ])
          parent.finish()

          await tracePromise
        })

        it('does not attribute a pool wait when the caller supplies the connection', async () => {
          const connection = await client.client.acquireConnection()
          const parent = tracer.startSpan('knex-external-connection-parent')
          const tracePromise = agent.assertSomeTraces(traces => {
            const spans = traces[0]
            const querySpans = spans.filter(span => span.name === database.querySpan)

            assert.ok(querySpans.length > 0)
            for (const span of querySpans) {
              assert.strictEqual(span.metrics[database.metric], undefined)
            }
            assert.strictEqual(
              spans.some(span => span.name === `${database.driver ?? database.client}.pool.acquire`),
              false
            )
          }, { spanResourceMatch: /^knex-external-connection-parent$/ })

          await tracer.scope().activate(parent, async () => {
            await client.raw('SELECT 1 AS one').connection(connection)
            await client.transaction(async transaction => {
              await transaction.raw('SELECT 1 AS one')
            }, { connection })
            parent.finish()
          })
          await client.client.releaseConnection(connection)

          await tracePromise
        })

        it('creates one driver acquire span for a direct acquireConnection call', async () => {
          const parent = tracer.startSpan('knex-acquire-parent')
          const tracePromise = assertAcquireTrace('knex-acquire-parent', database)

          await tracer.scope().activate(parent, async () => {
            const connection = await client.client.acquireConnection()
            await client.client.releaseConnection(connection)
            parent.finish()
          })

          await tracePromise
        })

        it('creates a driver acquire span with a dynamic connection provider', async () => {
          await client.destroy()
          client = knex({
            client: database.client,
            connection: () => ({ ...database.connection }),
            pool: { min: 0, max: 1 },
          })
          const parent = tracer.startSpan('knex-dynamic-acquire-parent')
          const tracePromise = assertAcquireTrace('knex-dynamic-acquire-parent', database)

          await tracer.scope().activate(parent, async () => {
            const connection = await client.client.acquireConnection()
            await client.client.releaseConnection(connection)
            parent.finish()
          })

          await tracePromise
        })

        it('creates an acquire error span when an internal acquisition fails before a query', async () => {
          await client.destroy()
          client = knex({
            client: database.client,
            connection: { ...database.connection },
            pool: { min: 0, max: 1 },
            acquireConnectionTimeout: 50,
          })
          const connection = await client.client.acquireConnection()
          const parent = tracer.startSpan('knex-timeout-parent')
          const tracePromise = agent.assertSomeTraces(traces => {
            const spans = traces[0]
            const acquireSpans = spans.filter(
              span => span.name === `${database.driver ?? database.client}.pool.acquire`
            )

            assert.strictEqual(acquireSpans.length, 1)
            assert.strictEqual(acquireSpans[0].error, 1)
            assert.strictEqual(acquireSpans[0].parent_id.toString(), parent.context().toSpanId())
            assert.strictEqual(spans.some(span => span.name === 'knex.pool.acquire'), false)
          }, { spanResourceMatch: /^knex-timeout-parent$/ })

          await tracer.scope().activate(parent, async () => {
            await assert.rejects(client.raw('SELECT 1 AS one'))
            parent.finish()
          })
          await client.client.releaseConnection(connection)

          await tracePromise
        })

        if (semver.satisfies(resolvedVersion, '>=3.3.0')) {
          it('measures a native-pool acquisition once at the outer Knex boundary', async () => {
            await client.destroy()

            nativePool = createNativePool(driver, database)
            client = knex({ client: database.client, connectionPool: nativePool })
            const parent = tracer.startSpan('knex-native-pool-parent')
            const tracePromise = assertAcquireTrace('knex-native-pool-parent', database)

            await tracer.scope().activate(parent, async () => {
              const connection = await client.client.acquireConnection()
              await client.client.releaseConnection(connection)
              parent.finish()
            })

            await tracePromise
          })

          if (database.client === 'pg') {
            it('keeps direct native-pool acquisition instrumentation', async () => {
              nativePool = createNativePool(driver, database)
              const parent = tracer.startSpan('pg-native-pool-parent')
              const tracePromise = agent.assertSomeTraces(traces => {
                const acquireSpans = traces[0].filter(span => span.name === 'pg.pool.acquire')

                assert.strictEqual(acquireSpans.length, 1)
              }, { spanResourceMatch: /^pg-native-pool-parent$/ })

              await tracer.scope().activate(parent, async () => {
                const connection = await nativePool.connect()
                connection.release()
                parent.finish()
              })

              await tracePromise
            })

            it('reports a rejected native-pool acquisition once', async () => {
              await client.destroy()

              const endedPool = createNativePool(driver, database)
              await endedPool.end()
              client = knex({ client: database.client, connectionPool: endedPool })
              const parent = tracer.startSpan('knex-native-pool-error-parent')
              const tracePromise = agent.assertSomeTraces(traces => {
                const spans = traces[0]
                const acquireSpans = spans.filter(span => span.name === 'pg.pool.acquire')

                assert.strictEqual(acquireSpans.length, 1)
                assert.strictEqual(acquireSpans[0].error, 1)
              }, { spanResourceMatch: /^knex-native-pool-error-parent$/ })

              await tracer.scope().activate(parent, async () => {
                await assert.rejects(client.client.acquireConnection())
                parent.finish()
              })

              await tracePromise
            })
          }
        }
      })
    })
  }
})

/**
 * @param {string} parentResource
 * @param {{ client: string, driver?: string, metric: string, querySpan: string }} database
 * @returns {Promise<void>}
 */
function assertQueryWaitTrace (parentResource, database) {
  return agent.assertSomeTraces(traces => {
    const spans = traces[0]
    const querySpans = spans.filter(span => span.name === database.querySpan &&
      span.metrics[database.metric] !== undefined)

    assert.strictEqual(querySpans.length, 1)
    assert.ok(querySpans[0].metrics[database.metric] > 0)
    assert.strictEqual(spans.some(span => span.name === `${database.driver ?? database.client}.pool.acquire`), false)
    assert.strictEqual(spans.some(span => span.name === 'knex.pool.acquire'), false)
  }, { spanResourceMatch: new RegExp(`^${parentResource}$`) })
}

/**
 * @param {string} parentResource
 * @param {{ client: string, driver?: string, metric: string }} database
 * @returns {Promise<void>}
 */
function assertAcquireTrace (parentResource, database) {
  return agent.assertSomeTraces(traces => {
    const spans = traces[0]
    const acquireSpans = spans.filter(span => span.name === `${database.driver ?? database.client}.pool.acquire`)

    assert.strictEqual(acquireSpans.length, 1)
    assert.strictEqual(typeof acquireSpans[0].metrics[database.metric], 'number')
    assert.strictEqual(spans.some(span => span.name === 'knex.pool.acquire'), false)
  }, { spanResourceMatch: new RegExp(`^${parentResource}$`) })
}

/**
 * @param {{ Pool?: Function, createPool?: Function }} driver
 * @param {{ client: string, connection: Record<string, unknown>, driver?: string }} database
 * @returns {object}
 */
function createNativePool (driver, database) {
  if ((database.driver ?? database.client) === 'pg') return new driver.Pool({ ...database.connection, max: 1 })
  return driver.createPool({ ...database.connection, connectionLimit: 1 })
}

/**
 * @param {{ end: Function }} pool
 * @param {string} driver
 * @returns {Promise<void>}
 */
function closeNativePool (pool, driver) {
  if (driver === 'pg') return pool.end()
  return new Promise((resolve, reject) => pool.end(error => error ? reject(error) : resolve()))
}

/**
 * @param {{ numPendingAcquires: () => number }} pool
 * @returns {Promise<void>}
 */
async function waitForPendingAcquire (pool) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (pool.numPendingAcquires() !== 0) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Expected a pending pool acquisition')
}
