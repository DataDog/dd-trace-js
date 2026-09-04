'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const queryStartCh = dc.channel('datadog:sequelize:query:start')

const databases = [
  {
    config: {
      database: 'db',
      databaseVersion: '10.4.0',
      dialect: 'mysql',
      host: '127.0.0.1',
      password: '',
      port: 3306,
      username: 'root',
    },
    driver: 'mysql2',
    metric: 'mysql2.pool.wait_time',
    querySpan: 'mysql.query',
    versions: [
      { driver: '3.9.3', sequelize: '>=4 <5' },
      { driver: '>=3.9.4', sequelize: '>=5' },
    ],
  },
  {
    config: {
      database: 'db',
      databaseVersion: '10.4.0',
      dialect: 'mariadb',
      host: '127.0.0.1',
      password: '',
      port: 3306,
      username: 'root',
    },
    driver: 'mariadb',
    metric: 'mariadb.pool.wait_time',
    querySpan: 'mariadb.query',
    versions: [{ driver: '2.5.6', sequelize: '>=5' }],
  },
  {
    config: {
      database: 'postgres',
      databaseVersion: '9.5.0',
      dialect: 'postgres',
      host: '127.0.0.1',
      password: 'postgres',
      port: Number(process.env.PG_TEST_PORT) || 5432,
      username: 'postgres',
    },
    driver: 'pg',
    metric: 'db.pool.wait_time_ms',
    querySpan: 'pg.query',
    versions: [{ driver: '8.7.3', sequelize: '>=6' }],
  },
]

describe('sequelize pool acquisition', () => {
  for (const database of databases) {
    describe(`with ${database.driver}`, () => {
      let tracer

      for (const versions of database.versions) {
        withVersions('sequelize', 'sequelize', versions.sequelize, sequelizeVersion => {
          /**
           * @param {string} driverVersion
           */
          function testDatabaseVersion (driverVersion) {
            let dialectModulePath
            let Sequelize
            let sequelize

            before(async () => {
              const pluginConfig = database.driver === 'pg' ? undefined : { service: config => config.database }
              tracer = await agent.load(database.driver, pluginConfig)
            })

            after(() => agent.close({ ritmReset: false }))

            beforeEach(() => {
              Sequelize = require(`../../../versions/sequelize@${sequelizeVersion}`).get().Sequelize
              dialectModulePath = require(`../../../versions/${database.driver}@${driverVersion}`).getPath()
              const config = database.config
              sequelize = new Sequelize(config.database, config.username, config.password, {
                databaseVersion: config.databaseVersion,
                dialect: config.dialect,
                dialectModulePath,
                host: config.host,
                logging: false,
                port: config.port,
                pool: { min: 0, max: 1 },
              })
            })

            afterEach(() => sequelize.close())

            it('adds a pool wait tag to a query instead of creating an acquire span', async () => {
              let queryStartCount = 0
              const onQueryStart = () => { queryStartCount++ }
              queryStartCh.subscribe(onQueryStart)

              const connection = await sequelize.connectionManager.getConnection()
              const parent = tracer.startSpan('sequelize-query-parent')
              const tracePromise = assertQueryWaitTrace('sequelize-query-parent', database)

              try {
                const queryPromise = tracer.scope().activate(parent, () => sequelize.query('SELECT 1 AS one'))
                await Promise.all([
                  queryPromise,
                  waitForPendingAcquire(sequelize.connectionManager.pool)
                    .finally(() => sequelize.connectionManager.releaseConnection(connection)),
                ])
                parent.finish()

                await tracePromise
                assert.ok(queryStartCount > 0)
              } finally {
                queryStartCh.unsubscribe(onQueryStart)
              }
            })

            it('adds a pool wait tag to the first transaction query', async () => {
              const connection = await sequelize.connectionManager.getConnection()
              const parent = tracer.startSpan('sequelize-transaction-parent')
              const tracePromise = assertQueryWaitTrace('sequelize-transaction-parent', database)

              const transactionPromise = tracer.scope().activate(parent, () => {
                return sequelize.transaction(async transaction => {
                  await sequelize.transaction({ transaction }, async nestedTransaction => {
                    await sequelize.query('SELECT 1 AS one', { transaction: nestedTransaction })
                  })
                })
              })
              await Promise.all([
                transactionPromise,
                waitForPendingAcquire(sequelize.connectionManager.pool)
                  .finally(() => sequelize.connectionManager.releaseConnection(connection)),
              ])
              parent.finish()

              await tracePromise
            })

            it('creates an acquire error span when acquisition fails before a query', async () => {
              await sequelize.close()

              const config = database.config
              sequelize = new Sequelize(config.database, config.username, config.password, {
                databaseVersion: config.databaseVersion,
                dialect: config.dialect,
                dialectModulePath,
                host: config.host,
                logging: false,
                port: config.port,
                pool: { acquire: 50, min: 0, max: 1 },
              })
              const connection = await sequelize.connectionManager.getConnection()
              const parent = tracer.startSpan('sequelize-timeout-parent')
              const tracePromise = agent.assertSomeTraces(traces => {
                const spans = traces[0]
                const acquireSpans = spans.filter(span => span.name === `${database.driver}.pool.acquire`)

                assert.strictEqual(acquireSpans.length, 1)
                assert.strictEqual(acquireSpans[0].error, 1)
                assert.strictEqual(acquireSpans[0].parent_id.toString(), parent.context().toSpanId())
                assert.strictEqual(spans.some(span => span.name === 'sequelize.pool.acquire'), false)
              }, { spanResourceMatch: /^sequelize-timeout-parent$/ })

              await tracer.scope().activate(parent, async () => {
                await assert.rejects(sequelize.query('SELECT 1 AS one'))
                parent.finish()
              })
              await sequelize.connectionManager.releaseConnection(connection)

              await tracePromise
            })

            if (database.driver !== 'pg') {
              it('selects the read and write pools for direct replicated acquires', async () => {
                await sequelize.close()

                const config = database.config
                const connectionConfig = {
                  database: config.database,
                  host: config.host,
                  password: config.password,
                  port: config.port,
                  username: config.username,
                }
                sequelize = new Sequelize(config.database, config.username, config.password, {
                  databaseVersion: config.databaseVersion,
                  dialect: config.dialect,
                  dialectModulePath,
                  logging: false,
                  pool: { min: 0, max: 1 },
                  replication: {
                    read: [{ ...connectionConfig, database: 'information_schema' }],
                    write: { ...connectionConfig },
                  },
                })

                const idleReadConnection = await sequelize.connectionManager.getConnection({ type: 'SELECT' })
                await sequelize.connectionManager.releaseConnection(idleReadConnection)

                const parent = tracer.startSpan('sequelize-replication-parent')
                const tracePromise = agent.assertSomeTraces(traces => {
                  const acquireSpans = traces[0].filter(span => span.name === `${database.driver}.pool.acquire`)

                  assert.strictEqual(acquireSpans.length, 2)
                  assert.strictEqual(acquireSpans[0].meta['db.name'], 'information_schema')
                  assert.strictEqual(acquireSpans[0].service, 'information_schema')
                  assert.strictEqual(acquireSpans[1].meta['db.name'], 'db')
                  assert.strictEqual(acquireSpans[1].service, 'db')
                }, { spanResourceMatch: /^sequelize-replication-parent$/ })

                await tracer.scope().activate(parent, async () => {
                  const readConnection = await sequelize.connectionManager.getConnection({ type: 'SELECT' })
                  await sequelize.connectionManager.releaseConnection(readConnection)
                  const writeConnection = await sequelize.connectionManager.getConnection({ type: 'UPDATE' })
                  await sequelize.connectionManager.releaseConnection(writeConnection)
                  parent.finish()
                })

                await tracePromise
              })
            }

            it('creates one driver acquire span for a direct getConnection call', async () => {
              const parent = tracer.startSpan('sequelize-acquire-parent')
              const tracePromise = agent.assertSomeTraces(traces => {
                const spans = traces[0]
                const acquireSpans = spans.filter(span => span.name === `${database.driver}.pool.acquire`)

                assert.strictEqual(acquireSpans.length, 1)
                assert.strictEqual(typeof acquireSpans[0].metrics[database.metric], 'number')
                assert.strictEqual(spans.some(span => span.name === 'sequelize.pool.acquire'), false)
              }, { spanResourceMatch: /^sequelize-acquire-parent$/ })

              await tracer.scope().activate(parent, async () => {
                const connection = await sequelize.connectionManager.getConnection()
                await sequelize.connectionManager.releaseConnection(connection)
                parent.finish()
              })

              await tracePromise
            })
          }

          withVersions('sequelize', database.driver, versions.driver, testDatabaseVersion)
        })
      }
    })
  }
})

/**
 * @param {string} parentResource
 * @param {{ driver: string, metric: string, querySpan: string }} database
 * @returns {Promise<void>}
 */
function assertQueryWaitTrace (parentResource, database) {
  return agent.assertSomeTraces(traces => {
    const spans = traces[0]
    const querySpans = spans.filter(span => span.name === database.querySpan &&
      span.metrics[database.metric] !== undefined)

    assert.strictEqual(querySpans.length, 1)
    assert.ok(querySpans[0].metrics[database.metric] > 0)
    assert.strictEqual(spans.some(span => span.name === `${database.driver}.pool.acquire`), false)
    assert.strictEqual(spans.some(span => span.name === 'sequelize.pool.acquire'), false)
  }, { spanResourceMatch: new RegExp(`^${parentResource}$`) })
}

/**
 * @param {{ waiting?: number, _waitingClientsQueue?: { length: number } }} pool
 * @returns {Promise<void>}
 */
async function waitForPendingAcquire (pool) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((pool.waiting ?? pool._waitingClientsQueue?.length) !== 0) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('Expected a pending pool acquisition')
}
