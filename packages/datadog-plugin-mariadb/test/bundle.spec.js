'use strict'

const assert = require('node:assert/strict')
const { mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const { ANY_STRING } = require('../../../integration-tests/helpers')
const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const connectionOptions = {
  host: 'localhost',
  user: 'root',
  database: 'db',
}

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

        it('traces batch and importFile operations', async () => {
          const assertion = assertTraceResources('bundle.promise.bulk', [
            'INSERT INTO dd_bundle_batch VALUES (?)',
            'IMPORT FILE',
            'IMPORT FILE',
          ])

          await connection.query('CREATE TEMPORARY TABLE dd_bundle_batch (value INT)')
          await tracer.trace('bundle.promise.bulk', async () => {
            await connection.batch('INSERT INTO dd_bundle_batch VALUES (?)', [[1], [2]])
            await connection.importFile({ file: importFilePath })
            await mariadb.importFile({ ...connectionOptions, file: importFilePath })
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

        it('traces pool clusters, falsy selectors, and unambiguous node metadata', async () => {
          const cluster = mariadb.createPoolCluster()
          cluster.add('primary', { ...connectionOptions, minimumIdle: 0 })
          const filteredAssertion = agent.assertFirstTraceSpan({
            resource: 'SELECT 7 AS cluster_query',
            meta: {
              'db.name': 'db',
              'db.user': 'root',
            },
          }, { spanResourceMatch: /cluster_query/ })
          const falsyAssertion = agent.assertFirstTraceSpan({
            resource: 'SELECT 8 AS falsy_cluster_query',
            meta: {
              'db.name': 'db',
              'db.user': 'root',
            },
          }, { spanResourceMatch: /falsy_cluster_query/ })

          try {
            await Promise.all([
              filteredAssertion,
              cluster.of('primary').query('SELECT 7 AS cluster_query'),
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

        it('traces batch and importFile operations', async () => {
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
              mariadb.importFile({ ...connectionOptions, file: importFilePath }, callback)
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

        it('traces pool clusters and uses unambiguous node metadata', async () => {
          const cluster = mariadb.createPoolCluster()
          cluster.add('primary', { ...connectionOptions, minimumIdle: 0 })
          const assertion = agent.assertFirstTraceSpan({
            resource: 'SELECT 16 AS callback_cluster_query',
            meta: {
              'db.name': 'db',
              'db.user': 'root',
            },
          })

          try {
            await Promise.all([
              assertion,
              callbackResult(callback => {
                cluster.of('primary').query('SELECT 16 AS callback_cluster_query', callback)
              }),
            ])
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
