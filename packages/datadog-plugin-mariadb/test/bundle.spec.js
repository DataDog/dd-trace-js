'use strict'

const assert = require('node:assert/strict')
const { mkdtemp, rm, writeFile } = require('node:fs/promises')
const net = require('node:net')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { setImmediate: nextImmediate } = require('node:timers/promises')
const { inspect } = require('node:util')

const dc = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const { ANY_STRING } = require('../../../integration-tests/helpers')
const { CLIENT_PORT_KEY, ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { withFakeNow, withoutImmediateClockRead } = require('./helpers')

const queryStartCh = dc.channel('apm:mariadb:query:start')

const connectionOptions = {
  host: 'localhost',
  user: 'root',
  database: 'db',
}
const noop = () => {}

/**
 * Resolves when a MariaDB callback reports success.
 *
 * @param {(callback: Function) => void} invoke
 * @returns {Promise<Array<unknown>>}
 */
function callbackResult (invoke) {
  return new Promise((resolve, reject) => {
    invoke((error, ...results) => error ? reject(error) : resolve(results))
  })
}

/**
 * Resolves after a MariaDB result stream ends.
 *
 * @param {import('node:stream').Readable} stream
 * @returns {Promise<void>}
 */
function consumeStream (stream) {
  return new Promise((resolve, reject) => {
    stream.once('error', reject)
    stream.once('end', resolve)
    stream.resume()
  })
}

/**
 * @returns {Promise<number>}
 */
async function getClosedPort () {
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return port
}

/**
 * Asserts every expected MariaDB resource in the trace containing the named root span.
 *
 * @param {string} rootName
 * @param {Array<string>} expectedResources
 * @returns {Promise<void>}
 */
function assertTraceResources (rootName, expectedResources) {
  return agent.assertSomeTraces(traces => {
    const trace = traces.find(trace => trace.some(span => span.name === rootName))
    assert.ok(trace, `${rootName} trace has not flushed yet`)

    const resources = []
    for (const span of trace) {
      if (span.meta.component === 'mariadb') resources.push(span.resource)
    }

    assert.deepStrictEqual(resources.sort(), expectedResources.sort())
  })
}

describe('Plugin', () => {
  describe('mariadb CommonJS bundle', () => {
    if (semver.lt(process.version, '20.0.0')) return

    withVersions('mariadb', 'mariadb', '3.5.3', version => {
      const versionModule = `../../../versions/mariadb@${version}`
      let importFilePath
      let temporaryDirectory

      before(async () => {
        temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'dd-trace-mariadb-'))
        importFilePath = path.join(temporaryDirectory, 'query.sql')
        await writeFile(importFilePath, 'SELECT 11 AS imported_statement;')
      })

      after(async () => {
        await rm(temporaryDirectory, { recursive: true })
      })

      describe('exports', () => {
        beforeEach(() => agent.load('mariadb'))
        afterEach(() => agent.close())

        for (const entry of ['mariadb', 'mariadb/callback']) {
          it(`preserves the ${entry} namespace descriptors`, () => {
            const mariadb = require(versionModule).get(entry)
            const esModuleDescriptor = Object.getOwnPropertyDescriptor(mariadb, '__esModule')
            const factoryDescriptor = Object.getOwnPropertyDescriptor(mariadb, 'createConnection')

            assert.deepStrictEqual(esModuleDescriptor, {
              value: true,
              writable: false,
              enumerable: false,
              configurable: false,
            })
            assert.strictEqual(typeof factoryDescriptor.get, 'function')
            assert.strictEqual(factoryDescriptor.set, undefined)
            assert.strictEqual(factoryDescriptor.enumerable, true)
            assert.strictEqual(factoryDescriptor.configurable, false)
            assert.strictEqual(mariadb.default.createConnection, mariadb.createConnection)
            assert.strictEqual(mariadb.default.createPool, mariadb.createPool)
            assert.strictEqual(mariadb.default.createPoolCluster, mariadb.createPoolCluster)
            assert.strictEqual(mariadb.default.importFile, mariadb.importFile)
          })
        }
      })

      describe('promise API', () => {
        let connection
        let mariadb
        let tracer

        beforeEach(async () => {
          tracer = await agent.load('mariadb')
          mariadb = require(versionModule).get('mariadb')
          connection = await mariadb.createConnection(connectionOptions)
        })

        afterEach(async () => {
          await connection.end()
          await agent.close()
        })

        it('traces query, execute, prepared, and streaming commands', async () => {
          const statement = await connection.prepare('SELECT ? AS prepared_query')
          const assertion = assertTraceResources('bundle.promise.commands', [
            'SELECT 1 AS object_query',
            'SELECT ? AS execute_query',
            'SELECT ? AS prepared_query',
            'SELECT 2 AS query_stream',
            'SELECT ? AS prepared_query',
          ])

          await tracer.trace('bundle.promise.commands', async () => {
            await connection.query({ sql: 'SELECT 1 AS object_query' })
            await connection.execute('SELECT ? AS execute_query', [2])
            await statement.execute([3])
            await consumeStream(connection.queryStream('SELECT 2 AS query_stream'))
            await consumeStream(statement.executeStream([4]))
          })

          statement.close()
          await assertion
        })

        it('tags bundled stream errors', async () => {
          const sql = 'SELECT * FROM definitely_missing_stream_table'

          await Promise.all([
            agent.assertFirstTraceSpan({
              resource: sql,
              meta: {
                [ERROR_TYPE]: ANY_STRING,
                [ERROR_MESSAGE]: ANY_STRING,
                [ERROR_STACK]: ANY_STRING,
              },
            }, { spanResourceMatch: /definitely_missing_stream_table/ }),
            assert.rejects(consumeStream(connection.queryStream(sql))),
          ])
        })

        it('traces transaction helpers only when MariaDB sends a command', async () => {
          const assertion = assertTraceResources('bundle.promise.transactions', [
            'START TRANSACTION',
            'SELECT 3 AS committed_query',
            'COMMIT',
            'START TRANSACTION',
            'ROLLBACK',
          ])

          await tracer.trace('bundle.promise.transactions', async () => {
            await connection.beginTransaction()
            await connection.query('SELECT 3 AS committed_query')
            await connection.commit()
            await connection.commit()
            await connection.beginTransaction()
            await connection.rollback()
          })

          await assertion
        })

        it('traces transactions queued behind untraced promise commands', async () => {
          const assertion = assertTraceResources('bundle.promise.queued_transactions', ['COMMIT', 'COMMIT'])

          await tracer.trace('bundle.promise.queued_transactions', async () => {
            const ping = connection.ping()
            const pingCommit = connection.commit()
            await Promise.all([ping, pingCommit])

            const prepare = connection.prepare('SELECT ? AS queued_promise_prepare')
            const prepareCommit = connection.commit()
            const [statement] = await Promise.all([prepare, prepareCommit])
            statement.close()
          })

          await assertion
        })

        it('traces batch and importFile operations', async () => {
          const importFile = mariadb.importFile
          const assertion = assertTraceResources('bundle.promise.bulk', [
            'INSERT INTO dd_bundle_batch VALUES (?)',
            'IMPORT FILE',
            'IMPORT FILE',
          ])

          await connection.query('CREATE TEMPORARY TABLE dd_bundle_batch (value INT)')
          await tracer.trace('bundle.promise.bulk', async () => {
            await connection.batch('INSERT INTO dd_bundle_batch VALUES (?)', [[1], [2]])
            await connection.importFile({ file: importFilePath })
            await importFile({ ...connectionOptions, file: importFilePath })
          })

          await assertion
        })

        it('traces pools, acquired connections, and connection-event wrappers', async () => {
          const pool = mariadb.createPool({ ...connectionOptions, connectionLimit: 1, minimumIdle: 0 })
          const eventQuery = new Promise((resolve, reject) => {
            pool.prependOnceListener('connection', eventConnection => {
              eventConnection.query('SELECT 4 AS event_query').then(resolve, reject)
            })
          })
          const eventAssertion = agent.assertFirstTraceSpan(
            { resource: 'SELECT 4 AS event_query' },
            { spanResourceMatch: /event_query/ }
          )
          const assertion = assertTraceResources('bundle.promise.pool', [
            'SELECT 5 AS pool_query',
            'SELECT ? AS pool_execute',
            'INSERT INTO dd_bundle_pool_batch VALUES (?)',
            'IMPORT FILE',
            'mariadb.pool.acquire',
            'SELECT 6 AS acquired_query',
          ])

          try {
            await pool.query('CREATE TEMPORARY TABLE dd_bundle_pool_batch (value INT)')
            await tracer.trace('bundle.promise.pool', async () => {
              await Promise.all([pool.query('SELECT 5 AS pool_query'), eventQuery, eventAssertion])
              await pool.execute('SELECT ? AS pool_execute', [6])
              await pool.batch('INSERT INTO dd_bundle_pool_batch VALUES (?)', [[1], [2]])
              await pool.importFile({ file: importFilePath, database: 'db' })
              const acquired = await pool.getConnection()
              await acquired.query('SELECT 6 AS acquired_query')
              await acquired.release()
            })

            await assertion
          } finally {
            await pool.end()
          }
        })

        for (const [method, sql] of [
          ['query', 'SELECT 23 AS bundle_pool_wait'],
          ['execute', 'SELECT 24 AS bundle_execute_pool_wait'],
        ]) {
          it(`records the pool acquire wait time on the bundled ${method} span`, async () => {
            const pool = mariadb.createPool({ ...connectionOptions, connectionLimit: 1, minimumIdle: 0 })

            try {
              await Promise.all([
                agent.assertSomeTraces(traces => {
                  const span = traces[0].find(span => span.resource === sql)

                  assert.ok(span, `missing query span: ${inspect(traces[0].map(span => span.resource))}`)
                  assert.strictEqual(typeof span.metrics['mariadb.pool.wait_time'], 'number')
                  assert.ok(span.metrics['mariadb.pool.wait_time'] >= 0)
                  assert.strictEqual(traces[0].find(span => span.name === 'mariadb.pool.acquire'), undefined)
                }, { spanResourceMatch: new RegExp(`^${sql}$`) }),
                pool[method](sql),
              ])
            } finally {
              await pool.end()
            }
          })
        }

        it('starts a bundled pooled promise command only after acquiring its connection', async () => {
          const pool = mariadb.createPool({ ...connectionOptions, connectionLimit: 1, minimumIdle: 0 })
          const connection = await pool.getConnection()
          const sql = 'SELECT 38 AS bundle_delayed_pool_start'
          let query
          let queryStarts = 0
          let released = false
          const onStart = ctx => {
            if (ctx.sql === sql) queryStarts++
          }
          queryStartCh.subscribe(onStart)

          try {
            query = pool.query(sql)
            assert.strictEqual(queryStarts, 0)

            await connection.release()
            released = true
            await query

            assert.strictEqual(queryStarts, 1)
          } finally {
            queryStartCh.unsubscribe(onStart)
            if (!released) await connection.release()
            await query?.catch(noop)
            await pool.end()
          }
        })

        it('uses zero wait without clock reads for a recent bundled pool connection', async () => {
          const pool = mariadb.createPool({
            ...connectionOptions,
            connectionLimit: 1,
            minDelayValidation: Number.MAX_SAFE_INTEGER,
          })

          try {
            await pool.query('SELECT 1')

            const assertion = agent.assertSomeTraces(traces => {
              const span = traces.flat().find(span => span.resource === 'SELECT 25 AS bundle_recent_idle')

              assert.ok(span, `missing query span: ${inspect(traces.flat().map(span => span.resource))}`)
              assert.strictEqual(span.metrics['mariadb.pool.wait_time'], 0)
            }, { spanResourceMatch: /^SELECT 25 AS bundle_recent_idle$/ })

            const query = withoutImmediateClockRead(() => pool.query('SELECT 25 AS bundle_recent_idle'))

            await Promise.all([assertion, query])
          } finally {
            await pool.end()
          }
        })

        it('includes bundled idle validation in the pool wait time', async () => {
          const pool = mariadb.createPool({
            ...connectionOptions,
            connectionLimit: 1,
            minDelayValidation: 0,
          })

          try {
            await pool.query('SELECT 1')

            const assertion = agent.assertSomeTraces(traces => {
              const span = traces.flat().find(span => span.resource === 'SELECT 26 AS bundle_validation')

              assert.ok(span, `missing query span: ${inspect(traces.flat().map(span => span.resource))}`)
              assert.strictEqual(span.metrics['mariadb.pool.wait_time'], 50)
            }, { spanResourceMatch: /^SELECT 26 AS bundle_validation$/ })

            await withFakeNow(100, async advanceTo => {
              const query = pool.query('SELECT 26 AS bundle_validation')
              advanceTo(150)
              await Promise.all([assertion, query])
            })
          } finally {
            await pool.end()
          }
        })

        it('creates an acquire span for an explicit bundled promise getConnection', async () => {
          const pool = mariadb.createPool({ ...connectionOptions, connectionLimit: 1, minimumIdle: 0 })
          const parent = tracer.startSpan('bundle-promise-acquire-parent')

          try {
            await Promise.all([
              agent.assertSomeTraces(traces => {
                const acquireSpan = traces[0].find(span => span.name === 'mariadb.pool.acquire')

                assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
                assert.strictEqual(acquireSpan.parent_id.toString(), parent.context().toSpanId())
                assert.strictEqual(typeof acquireSpan.metrics['mariadb.pool.wait_time'], 'number')
              }, { spanResourceMatch: /^mariadb\.pool\.acquire$/ }),
              tracer.scope().activate(parent, async () => {
                const acquired = await pool.getConnection()
                await acquired.release()
                parent.finish()
              }),
            ])
          } finally {
            await pool.end()
          }
        })

        it('does not classify reentrant bundled pool operations as each other', async () => {
          const pool = mariadb.createPool({
            ...connectionOptions,
            connectionLimit: 1,
            minDelayValidation: Number.MAX_SAFE_INTEGER,
          })

          try {
            await pool.query('CREATE TEMPORARY TABLE dd_bundle_reentrant (value INT)')
            let batch
            pool.once('acquire', () => {
              batch = withoutImmediateClockRead(() => {
                return pool.batch('INSERT INTO dd_bundle_reentrant VALUES (?)', [[1]])
              })
            })

            await pool.query('SELECT 27 AS bundle_reentrant')
            assert.ok(batch, 'reentrant batch did not start')
            await batch
          } finally {
            await pool.end()
          }
        })

        it('preserves bundled pool acquisition order across queue compaction', async () => {
          const pool = mariadb.createPool({ ...connectionOptions, connectionLimit: 1, minimumIdle: 0 })
          const connection = await pool.getConnection()
          const queries = new Array(1025)
          let released = false

          try {
            for (let index = 0; index < queries.length; index++) {
              queries[index] = pool.query('SELECT 1 AS compaction_probe')
            }

            await connection.release()
            released = true
            const results = await Promise.all(queries)

            assert.strictEqual(results.length, 1025)
            assert.strictEqual(results[0][0].compaction_probe, 1)
            assert.strictEqual(results[1024][0].compaction_probe, 1)
          } finally {
            if (!released) await connection.release()
            await pool.end()
          }
        })

        it('forwards bundled pool operations without subscribers', async () => {
          const pool = mariadb.createPool({ ...connectionOptions, connectionLimit: 1, minimumIdle: 0 })

          tracer.use('mariadb', false)
          try {
            const rows = await pool.query('SELECT 28 AS bundle_untraced_pool')
            const acquired = await pool.getConnection()

            await acquired.release()
            assert.strictEqual(rows[0].bundle_untraced_pool, 28)
          } finally {
            tracer.use('mariadb', true)
            await pool.end()
          }
        })

        it('records errors for explicit and pooled bundled acquisition failures', async () => {
          const pool = mariadb.createPool({
            ...connectionOptions,
            acquireTimeout: 500,
            connectTimeout: 100,
            host: '127.0.0.1',
            port: await getClosedPort(),
          })
          pool.on('error', noop)
          const forbiddenResources = new Set([
            'SELECT 29 AS bundle_query_acquire_failure',
            'SELECT 30 AS bundle_execute_acquire_failure',
          ])
          const noQuerySpans = agent.assertNoTraces(traces => {
            const span = traces.flat().find(span => forbiddenResources.has(span.resource))
            assert.strictEqual(span, undefined, `unexpected query span for failed acquisition: ${span?.resource}`)
          })

          try {
            for (const [method, args] of [
              ['getConnection', []],
              ['query', ['SELECT 29 AS bundle_query_acquire_failure']],
              ['execute', ['SELECT 30 AS bundle_execute_acquire_failure']],
            ]) {
              await Promise.all([
                agent.assertSomeTraces(traces => {
                  const acquireSpan = traces[0].find(span => span.name === 'mariadb.pool.acquire')

                  assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
                  assert.strictEqual(acquireSpan.error, 1)
                  assert.strictEqual(typeof acquireSpan.metrics['mariadb.pool.wait_time'], 'number')
                }),
                assert.rejects(pool[method](...args)),
              ])
            }
            await noQuerySpans
          } finally {
            noQuerySpans.cancel()
            await pool.end()
          }
        })

        it('keeps bundled pool acquisition tracking after acquire listeners are removed', async () => {
          const pool = mariadb.createPool({ ...connectionOptions, connectionLimit: 1, minimumIdle: 0 })
          const rootName = 'bundle.promise.removed_acquire_listeners'
          const sql = 'SELECT * FROM dd_missing_bundle_listener_probe'

          try {
            await pool.query('SELECT 1')
            pool.on('removeListener', () => {})
            pool.removeAllListeners('acquire')

            const assertion = agent.assertSomeTraces(traces => {
              const trace = traces.find(trace => trace.some(span => span.name === rootName))
              assert.ok(trace, `${rootName} trace has not flushed yet`)

              const querySpan = trace.find(span => span.resource === sql)
              assert.ok(querySpan, `missing query span: ${inspect(trace.map(span => span.resource))}`)
              assert.strictEqual(typeof querySpan.metrics['mariadb.pool.wait_time'], 'number')
              assert.strictEqual(trace.find(span => span.name === 'mariadb.pool.acquire'), undefined)
            }, { spanResourceMatch: new RegExp(`^${rootName}$`) })

            await assert.rejects(tracer.trace(rootName, () => pool.query(sql)))
            await assertion
          } finally {
            await pool.end()
          }
        })

        it('reports failed bundled promise cluster node acquisitions', async () => {
          const cluster = mariadb.createPoolCluster({ canRetry: false })
          const rootName = 'bundle.promise.cluster_acquire_failure'
          cluster.add('failing', {
            ...connectionOptions,
            acquireTimeout: 500,
            connectTimeout: 100,
            host: '127.0.0.1',
            minimumIdle: 0,
            port: await getClosedPort(),
          })

          try {
            const assertion = agent.assertSomeTraces(traces => {
              const trace = traces.find(trace => trace.some(span => span.name === rootName))
              assert.ok(trace, `${rootName} trace has not flushed yet`)

              const acquireSpan = trace.find(span => span.name === 'mariadb.pool.acquire')
              assert.ok(acquireSpan, `missing acquire span: ${inspect(trace.map(span => span.name))}`)
              assert.strictEqual(acquireSpan.error, 1)
              assert.strictEqual(typeof acquireSpan.metrics['mariadb.pool.wait_time'], 'number')
            }, { spanResourceMatch: new RegExp(`^${rootName}$`) })

            await assert.rejects(tracer.trace(rootName, () => cluster.of('failing').query('SELECT 36')))
            await assertion
          } finally {
            await cluster.end()
          }
        })

        it('traces pool clusters, falsy selectors, and selected node metadata', async () => {
          const cluster = mariadb.createPoolCluster()
          cluster.add('primary', { ...connectionOptions, minimumIdle: 0 })
          cluster.add('secondary', { ...connectionOptions, host: '127.0.0.1', minimumIdle: 0 })
          const filteredCluster = cluster.of(/^(primary|secondary)$/, 'RR')
          const filteredAssertion = agent.assertFirstTraceSpan({
            resource: 'SELECT 7 AS cluster_query',
            meta: {
              'db.name': 'db',
              'db.user': 'root',
              'out.host': '127.0.0.1',
            },
            metrics: { [CLIENT_PORT_KEY]: 3306 },
          }, { spanResourceMatch: /cluster_query/ })
          const falsyAssertion = agent.assertFirstTraceSpan({
            resource: 'SELECT 8 AS falsy_cluster_query',
            meta: {
              'db.name': 'db',
              'db.user': 'root',
              'out.host': 'localhost',
            },
            metrics: { [CLIENT_PORT_KEY]: 3306 },
          }, { spanResourceMatch: /falsy_cluster_query/ })

          try {
            const firstConnection = await filteredCluster.getConnection()
            await firstConnection.release()
            await Promise.all([
              filteredAssertion,
              filteredCluster.query('SELECT 7 AS cluster_query'),
            ])
            const acquired = await cluster.getConnection(false)
            await Promise.all([
              falsyAssertion,
              acquired.query('SELECT 8 AS falsy_cluster_query'),
            ])
            await acquired.release()
          } finally {
            await cluster.end()
          }
        })

        it('retains metadata when an automatically removed node is immediately re-added', async () => {
          const cluster = mariadb.createPoolCluster({ canRetry: false, removeNodeErrorCount: 1 })
          cluster.add('primary', {
            ...connectionOptions,
            host: '127.0.0.1',
            port: 1,
            acquireTimeout: 100,
            connectTimeout: 50,
            minimumIdle: 0,
          })

          try {
            await assert.rejects(cluster.getConnection('primary'))
            cluster.add('primary', { ...connectionOptions, minimumIdle: 0 })
            await nextImmediate()

            const assertion = agent.assertFirstTraceSpan({
              resource: 'SELECT 21 AS readded_cluster_query',
              meta: {
                'db.name': 'db',
                'db.user': 'root',
                'out.host': 'localhost',
              },
              metrics: { [CLIENT_PORT_KEY]: 3306 },
            }, { spanResourceMatch: /readded_cluster_query/ })
            const acquired = await cluster.getConnection('primary')

            try {
              await Promise.all([
                assertion,
                acquired.query('SELECT 21 AS readded_cluster_query'),
              ])
            } finally {
              await acquired.release()
            }
          } finally {
            await cluster.end()
          }
        })

        it('preserves promise continuation context and tags errors', async () => {
          const parent = tracer.startSpan('bundle.promise.parent')
          await tracer.scope().activate(parent, () => {
            return connection.query('SELECT 8 AS context_query').then(() => {
              assert.strictEqual(tracer.scope().active(), parent)
            })
          })
          parent.finish()

          await Promise.all([
            agent.assertFirstTraceSpan({
              resource: 'SELECT * FROM definitely_missing_bundle_table',
              meta: {
                [ERROR_TYPE]: ANY_STRING,
                [ERROR_MESSAGE]: ANY_STRING,
                [ERROR_STACK]: ANY_STRING,
              },
            }, { spanResourceMatch: /definitely_missing_bundle_table/ }),
            connection.query('SELECT * FROM definitely_missing_bundle_table').catch(() => {}),
          ])
        })
      })

      describe('callback API', () => {
        let connection
        let mariadb
        let tracer

        beforeEach(async () => {
          tracer = await agent.load('mariadb')
          mariadb = require(versionModule).get('mariadb/callback')
          connection = mariadb.createConnection(connectionOptions)
          await callbackResult(callback => connection.connect(callback))
        })

        afterEach(async () => {
          await callbackResult(callback => connection.end(callback))
          await agent.close()
        })

        it('traces query, execute, prepared, and streaming commands', async () => {
          const [statement] = await callbackResult(callback => {
            connection.prepare('SELECT ? AS callback_prepared', callback)
          })
          const assertion = assertTraceResources('bundle.callback.commands', [
            'SELECT 9 AS callback_query',
            'SELECT ? AS callback_execute',
            'SELECT ? AS callback_prepared',
            'SELECT ? AS callback_prepared',
            'SELECT 10 AS callback_stream',
            'SELECT ? AS callback_prepared',
          ])

          await tracer.trace('bundle.callback.commands', async () => {
            await callbackResult(callback => connection.query('SELECT 9 AS callback_query', callback))
            await callbackResult(callback => connection.execute('SELECT ? AS callback_execute', [10], callback))
            await callbackResult(callback => statement.execute([11], callback))
            await statement.execute([12])
            await consumeStream(connection.queryStream('SELECT 10 AS callback_stream'))
            await consumeStream(statement.executeStream([13]))
          })

          statement.close()
          await assertion
        })

        it('traces transaction helpers only when MariaDB sends a command', async () => {
          const assertion = assertTraceResources('bundle.callback.transactions', [
            'START TRANSACTION',
            'SELECT 12 AS callback_committed_query',
            'COMMIT',
            'START TRANSACTION',
            'ROLLBACK',
          ])

          await tracer.trace('bundle.callback.transactions', async () => {
            await callbackResult(callback => connection.beginTransaction(callback))
            await callbackResult(callback => connection.query('SELECT 12 AS callback_committed_query', callback))
            await callbackResult(callback => connection.commit(callback))
            await callbackResult(callback => connection.commit(callback))
            await callbackResult(callback => connection.beginTransaction(callback))
            await callbackResult(callback => connection.rollback(callback))
          })

          await assertion
        })

        it('traces transactions queued behind untraced callback commands', async () => {
          const assertion = assertTraceResources('bundle.callback.queued_transactions', ['COMMIT', 'COMMIT'])

          await tracer.trace('bundle.callback.queued_transactions', async () => {
            const ping = callbackResult(callback => connection.ping(callback))
            const pingCommit = callbackResult(callback => connection.commit(callback))
            await Promise.all([ping, pingCommit])

            const prepare = callbackResult(callback => {
              connection.prepare('SELECT ? AS queued_callback_prepare', callback)
            })
            const prepareCommit = callbackResult(callback => connection.commit(callback))
            const [[statement]] = await Promise.all([prepare, prepareCommit])
            statement.close()
          })

          await assertion
        })

        it('traces batch and importFile operations', async () => {
          const importFile = mariadb.importFile
          const assertion = assertTraceResources('bundle.callback.bulk', [
            'INSERT INTO dd_bundle_callback_batch VALUES (?)',
            'IMPORT FILE',
            'IMPORT FILE',
          ])

          await callbackResult(callback => {
            connection.query('CREATE TEMPORARY TABLE dd_bundle_callback_batch (value INT)', callback)
          })
          await tracer.trace('bundle.callback.bulk', async () => {
            await callbackResult(callback => {
              connection.batch('INSERT INTO dd_bundle_callback_batch VALUES (?)', [[1], [2]], callback)
            })
            await callbackResult(callback => connection.importFile({ file: importFilePath }, callback))
            await callbackResult(callback => {
              importFile({ ...connectionOptions, file: importFilePath }, callback)
            })
          })

          await assertion
        })

        it('replaces explicit empty callback slots', async () => {
          const pool = mariadb.createPool({ ...connectionOptions, connectionLimit: 1, minimumIdle: 0 })
          const assertion = assertTraceResources('bundle.callback.empty_callbacks', [
            'SELECT 18 AS callback_empty_query',
            'IMPORT FILE',
            'START TRANSACTION',
            'SELECT 19 AS callback_empty_pool_query',
            'SELECT 20 AS callback_empty_pool_barrier',
          ])

          try {
            await tracer.trace('bundle.callback.empty_callbacks', async () => {
              connection.query('SELECT 18 AS callback_empty_query', [], undefined)
              connection.importFile({ file: importFilePath }, null)
              connection.beginTransaction(undefined)
              await callbackResult(callback => connection.ping(callback))

              pool.query('SELECT 19 AS callback_empty_pool_query', [], undefined)
              await callbackResult(callback => pool.query('SELECT 20 AS callback_empty_pool_barrier', callback))
            })

            await assertion
          } finally {
            await callbackResult(callback => pool.end(callback))
          }
        })

        it('traces pools, acquired connections, and connection-event wrappers', async () => {
          const pool = mariadb.createPool({ ...connectionOptions, connectionLimit: 1, minimumIdle: 0 })
          const eventQuery = new Promise((resolve, reject) => {
            pool.prependOnceListener('connection', eventConnection => {
              eventConnection.query('SELECT 13 AS callback_event_query', error => error ? reject(error) : resolve())
            })
          })
          const eventAssertion = agent.assertFirstTraceSpan(
            { resource: 'SELECT 13 AS callback_event_query' },
            { spanResourceMatch: /callback_event_query/ }
          )
          const assertion = assertTraceResources('bundle.callback.pool', [
            'SELECT 14 AS callback_pool_query',
            'SELECT ? AS callback_pool_execute',
            'INSERT INTO dd_bundle_callback_pool_batch VALUES (?)',
            'IMPORT FILE',
            'mariadb.pool.acquire',
            'SELECT 15 AS callback_acquired_query',
          ])

          try {
            await callbackResult(callback => {
              pool.query('CREATE TEMPORARY TABLE dd_bundle_callback_pool_batch (value INT)', callback)
            })
            await tracer.trace('bundle.callback.pool', async () => {
              await Promise.all([
                callbackResult(callback => pool.query('SELECT 14 AS callback_pool_query', callback)),
                eventQuery,
                eventAssertion,
              ])
              await callbackResult(callback => pool.execute('SELECT ? AS callback_pool_execute', [15], callback))
              await callbackResult(callback => {
                pool.batch('INSERT INTO dd_bundle_callback_pool_batch VALUES (?)', [[1], [2]], callback)
              })
              await callbackResult(callback => pool.importFile({ file: importFilePath, database: 'db' }, callback))
              const [acquired] = await callbackResult(callback => pool.getConnection(callback))
              await callbackResult(callback => acquired.query('SELECT 15 AS callback_acquired_query', callback))
              await callbackResult(callback => acquired.release(callback))
            })

            await assertion
          } finally {
            await callbackResult(callback => pool.end(callback))
          }
        })

        it('records the pool acquire wait time on a bundled callback query span', async () => {
          const pool = mariadb.createPool({ ...connectionOptions, connectionLimit: 1, minimumIdle: 0 })
          const sql = 'SELECT 31 AS bundle_callback_pool_wait'

          try {
            await Promise.all([
              agent.assertSomeTraces(traces => {
                const span = traces[0].find(span => span.resource === sql)

                assert.ok(span, `missing query span: ${inspect(traces[0].map(span => span.resource))}`)
                assert.strictEqual(typeof span.metrics['mariadb.pool.wait_time'], 'number')
                assert.ok(span.metrics['mariadb.pool.wait_time'] >= 0)
                assert.strictEqual(traces[0].find(span => span.name === 'mariadb.pool.acquire'), undefined)
              }, { spanResourceMatch: new RegExp(`^${sql}$`) }),
              callbackResult(callback => pool.query(sql, callback)),
            ])
          } finally {
            await callbackResult(callback => pool.end(callback))
          }
        })

        it('starts a bundled pooled callback command only after acquiring its connection', async () => {
          const pool = mariadb.createPool({ ...connectionOptions, connectionLimit: 1, minimumIdle: 0 })
          const [connection] = await callbackResult(callback => pool.getConnection(callback))
          const sql = 'SELECT 39 AS bundle_delayed_callback_pool_start'
          let query
          let queryStarts = 0
          let released = false
          const onStart = ctx => {
            if (ctx.sql === sql) queryStarts++
          }
          queryStartCh.subscribe(onStart)

          try {
            query = callbackResult(callback => pool.query(sql, callback))
            assert.strictEqual(queryStarts, 0)

            await callbackResult(callback => connection.release(callback))
            released = true
            await query

            assert.strictEqual(queryStarts, 1)
          } finally {
            queryStartCh.unsubscribe(onStart)
            if (!released) await callbackResult(callback => connection.release(callback))
            await query?.catch(noop)
            await callbackResult(callback => pool.end(callback))
          }
        })

        it('forwards bundled callback pool operations without subscribers', async () => {
          const pool = mariadb.createPool({ ...connectionOptions, connectionLimit: 1, minimumIdle: 0 })

          tracer.use('mariadb', false)
          try {
            const [rows] = await callbackResult(callback => {
              pool.query('SELECT 34 AS bundle_untraced_callback_pool', callback)
            })
            const [acquired] = await callbackResult(callback => pool.getConnection(callback))

            await callbackResult(callback => acquired.release(callback))
            assert.strictEqual(rows[0].bundle_untraced_callback_pool, 34)
          } finally {
            tracer.use('mariadb', true)
            await callbackResult(callback => pool.end(callback))
          }
        })

        it('creates an acquire span for an explicit bundled callback getConnection', async () => {
          const pool = mariadb.createPool({ ...connectionOptions, connectionLimit: 1, minimumIdle: 0 })
          const parent = tracer.startSpan('bundle-callback-acquire-parent')

          try {
            await Promise.all([
              agent.assertSomeTraces(traces => {
                const acquireSpan = traces[0].find(span => span.name === 'mariadb.pool.acquire')

                assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
                assert.strictEqual(acquireSpan.parent_id.toString(), parent.context().toSpanId())
                assert.strictEqual(typeof acquireSpan.metrics['mariadb.pool.wait_time'], 'number')
              }, { spanResourceMatch: /^mariadb\.pool\.acquire$/ }),
              tracer.scope().activate(parent, async () => {
                const [acquired] = await callbackResult(callback => pool.getConnection(callback))
                await callbackResult(callback => acquired.release(callback))
                parent.finish()
              }),
            ])
          } finally {
            await callbackResult(callback => pool.end(callback))
          }
        })

        it('records errors for bundled callback pool acquisition failures', async () => {
          const pool = mariadb.createPool({
            ...connectionOptions,
            acquireTimeout: 500,
            connectTimeout: 100,
            host: '127.0.0.1',
            port: await getClosedPort(),
          })
          pool.on('error', noop)
          const forbiddenResources = new Set([
            'SELECT 32 AS bundle_callback_query_acquire_failure',
            'SELECT 33 AS bundle_callback_execute_acquire_failure',
          ])
          const noQuerySpans = agent.assertNoTraces(traces => {
            const span = traces.flat().find(span => forbiddenResources.has(span.resource))
            assert.strictEqual(span, undefined, `unexpected query span for failed acquisition: ${span?.resource}`)
          })

          try {
            for (const [method, args] of [
              ['getConnection', []],
              ['query', ['SELECT 32 AS bundle_callback_query_acquire_failure']],
              ['execute', ['SELECT 33 AS bundle_callback_execute_acquire_failure']],
            ]) {
              await Promise.all([
                agent.assertSomeTraces(traces => {
                  const acquireSpan = traces[0].find(span => span.name === 'mariadb.pool.acquire')

                  assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
                  assert.strictEqual(acquireSpan.error, 1)
                  assert.strictEqual(typeof acquireSpan.metrics['mariadb.pool.wait_time'], 'number')
                }),
                assert.rejects(callbackResult(callback => pool[method](...args, callback))),
              ])
            }
            await noQuerySpans
          } finally {
            noQuerySpans.cancel()
            await callbackResult(callback => pool.end(callback))
          }
        })

        it('records a synchronous bundled callback pool acquisition failure', async () => {
          const pool = mariadb.createPool({ ...connectionOptions, connectionLimit: 1, minimumIdle: 0 })
          await callbackResult(callback => pool.end(callback))

          await Promise.all([
            agent.assertSomeTraces(traces => {
              const acquireSpan = traces[0].find(span => span.name === 'mariadb.pool.acquire')

              assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
              assert.strictEqual(acquireSpan.error, 1)
              assert.strictEqual(acquireSpan.metrics['mariadb.pool.wait_time'], 0)
            }),
            assert.rejects(callbackResult(callback => {
              pool.query('SELECT 35 AS bundle_closed_pool_acquire_failure', callback)
            })),
          ])
        })

        it('keeps bundled callback pool acquisition tracking after acquire listeners are removed', async () => {
          const pool = mariadb.createPool({ ...connectionOptions, connectionLimit: 1, minimumIdle: 0 })
          const rootName = 'bundle.callback.removed_acquire_listeners'
          const sql = 'SELECT * FROM dd_missing_callback_listener_probe'

          try {
            await callbackResult(callback => pool.query('SELECT 1', callback))
            pool.removeAllListeners('acquire')

            const assertion = agent.assertSomeTraces(traces => {
              const trace = traces.find(trace => trace.some(span => span.name === rootName))
              assert.ok(trace, `${rootName} trace has not flushed yet`)

              const querySpan = trace.find(span => span.resource === sql)
              assert.ok(querySpan, `missing query span: ${inspect(trace.map(span => span.resource))}`)
              assert.strictEqual(typeof querySpan.metrics['mariadb.pool.wait_time'], 'number')
              assert.strictEqual(trace.find(span => span.name === 'mariadb.pool.acquire'), undefined)
            }, { spanResourceMatch: new RegExp(`^${rootName}$`) })

            await assert.rejects(tracer.trace(rootName, () => {
              return callbackResult(callback => pool.query(sql, callback))
            }))
            await assertion
          } finally {
            await callbackResult(callback => pool.end(callback))
          }
        })

        it('reports failed bundled callback cluster acquisitions without a matching node', async () => {
          const cluster = mariadb.createPoolCluster({ canRetry: false })
          const rootName = 'bundle.callback.cluster_acquire_failure'

          try {
            const assertion = agent.assertSomeTraces(traces => {
              const trace = traces.find(trace => trace.some(span => span.name === rootName))
              assert.ok(trace, `${rootName} trace has not flushed yet`)

              const acquireSpan = trace.find(span => span.name === 'mariadb.pool.acquire')
              assert.ok(acquireSpan, `missing acquire span: ${inspect(trace.map(span => span.name))}`)
              assert.strictEqual(acquireSpan.error, 1)
              assert.strictEqual(typeof acquireSpan.metrics['mariadb.pool.wait_time'], 'number')
            }, { spanResourceMatch: new RegExp(`^${rootName}$`) })

            await assert.rejects(tracer.trace(rootName, () => {
              return callbackResult(callback => cluster.of('missing').query('SELECT 37', callback))
            }))
            await assertion
          } finally {
            await callbackResult(callback => cluster.end(callback))
          }
        })

        it('traces pool clusters and uses selected node metadata', async () => {
          const cluster = mariadb.createPoolCluster()
          cluster.add('primary', { ...connectionOptions, minimumIdle: 0 })
          cluster.add('secondary', { ...connectionOptions, host: '127.0.0.1', minimumIdle: 0 })
          const filteredCluster = cluster.of(/^(primary|secondary)$/, 'RR')
          const assertion = agent.assertFirstTraceSpan({
            resource: 'SELECT 16 AS callback_cluster_query',
            meta: {
              'db.name': 'db',
              'db.user': 'root',
              'out.host': '127.0.0.1',
            },
            metrics: { [CLIENT_PORT_KEY]: 3306 },
          })

          try {
            const [firstConnection] = await callbackResult(callback => filteredCluster.getConnection(callback))
            await callbackResult(callback => firstConnection.release(callback))
            await Promise.all([
              assertion,
              callbackResult(callback => {
                filteredCluster.query('SELECT 16 AS callback_cluster_query', callback)
              }),
            ])
          } finally {
            await callbackResult(callback => cluster.end(callback))
          }
        })

        it('retains metadata when an automatically removed node is immediately re-added', async () => {
          const cluster = mariadb.createPoolCluster({ canRetry: false, removeNodeErrorCount: 1 })
          cluster.add('primary', {
            ...connectionOptions,
            host: '127.0.0.1',
            port: 1,
            acquireTimeout: 100,
            connectTimeout: 50,
            minimumIdle: 0,
          })

          try {
            await assert.rejects(callbackResult(callback => cluster.getConnection('primary', callback)))
            cluster.add('primary', { ...connectionOptions, minimumIdle: 0 })
            await nextImmediate()

            const assertion = agent.assertFirstTraceSpan({
              resource: 'SELECT 22 AS callback_readded_cluster_query',
              meta: {
                'db.name': 'db',
                'db.user': 'root',
                'out.host': 'localhost',
              },
              metrics: { [CLIENT_PORT_KEY]: 3306 },
            }, { spanResourceMatch: /callback_readded_cluster_query/ })
            const [acquired] = await callbackResult(callback => cluster.getConnection('primary', callback))

            try {
              await Promise.all([
                assertion,
                callbackResult(callback => {
                  acquired.query('SELECT 22 AS callback_readded_cluster_query', callback)
                }),
              ])
            } finally {
              await callbackResult(callback => acquired.release(callback))
            }
          } finally {
            await callbackResult(callback => cluster.end(callback))
          }
        })

        it('preserves callback context and tags errors', async () => {
          const parent = tracer.startSpan('bundle.callback.parent')
          await new Promise((resolve, reject) => {
            tracer.scope().activate(parent, () => {
              connection.query('SELECT 17 AS callback_context_query', error => {
                if (error) return reject(error)
                try {
                  assert.strictEqual(tracer.scope().active(), parent)
                  resolve()
                } catch (assertionError) {
                  reject(assertionError)
                }
              })
            })
          })
          parent.finish()

          const errorPromise = callbackResult(callback => {
            connection.query('SELECT * FROM definitely_missing_callback_bundle_table', callback)
          }).catch(() => {})
          await Promise.all([
            agent.assertFirstTraceSpan({
              resource: 'SELECT * FROM definitely_missing_callback_bundle_table',
              meta: {
                [ERROR_TYPE]: ANY_STRING,
                [ERROR_MESSAGE]: ANY_STRING,
                [ERROR_STACK]: ANY_STRING,
              },
            }, { spanResourceMatch: /definitely_missing_callback_bundle_table/ }),
            errorPromise,
          ])
        })
      })
    })
  })
})
