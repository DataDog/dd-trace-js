'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const semver = require('semver')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { ANY_STRING, assertObjectContains } = require('../../../integration-tests/helpers')
const { expectedSchema, rawExpectedSchema } = require('./naming')

// https://github.com/mariadb-corporation/mariadb-connector-nodejs/commit/0a90b71ab20ab4e8b6a86a77ba291bba8ba6a34e
const lowerBound = semver.gte(process.version, '15.0.0') ? '>=2.5.1' : '>=2'
// mariadb 3.5.1 and 3.5.2 are ESM-only, so they are covered by the ESM integration test instead of this CJS fixture.
const range = semver.gte(process.version, '20.0.0')
  ? `${lowerBound} <3.5.1 || >=3.5.3`
  : `${lowerBound} <3.5.1`

/**
 * Loads MariaDB through its real CommonJS entry when testing bundled exports.
 *
 * @param {string} version
 * @param {string} resolvedVersion
 * @param {string} entry
 * @returns {object}
 */
function loadMariadb (version, resolvedVersion, entry) {
  const versionModule = `../../../versions/mariadb@${version}`
  if (semver.gte(resolvedVersion, '3.5.3')) return require(versionModule).get(entry)
  return proxyquire(versionModule, {}).get(entry)
}

// A pool created inside an active span must not attach its connection-setup
// `tcp.connect` span to that trace. Accumulate span names across every payload
// and assert once the root `test` span flushed: a single trace from one payload
// lets a late partial flush (a lone `mariadb.query`) pass while the leaked
// `tcp.connect` rode an earlier payload — the source of this test's flakiness.
function assertNoConnectionSpanLeak () {
  const names = new Set()

  return agent.assertSomeTraces(traces => {
    for (const trace of traces) {
      for (const span of trace) {
        names.add(span.name)
      }
    }

    assert.ok(names.has('test'), 'root span has not flushed yet')
    assert.strictEqual(names.has('tcp.connect'), false, 'tcp.connect leaked into the request trace')
  })
}

function assertTransactionSpans () {
  return agent.assertSomeTraces(traces => {
    const trace = traces.find(trace => trace.some(span => span.name === 'test'))
    assert.ok(trace, 'transaction trace has not flushed yet')

    const resources = trace
      .filter(span => span.meta.component === 'mariadb')
      .map(span => span.resource)
      .sort()

    assert.deepStrictEqual(resources, ['COMMIT', 'ROLLBACK', 'START TRANSACTION', 'START TRANSACTION'])
  })
}

function consumeStream (stream) {
  return new Promise((resolve, reject) => {
    stream.once('error', reject)
    stream.once('end', resolve)
    stream.resume()
  })
}

function assertQueuedTransactionSpan (sql, transaction) {
  return agent.assertSomeTraces(traces => {
    const trace = traces.find(trace => trace.some(span => span.name === 'test'))
    assert.ok(trace, 'queued transaction trace has not flushed yet')
    const resources = trace.filter(span => span.meta.component === 'mariadb').map(span => span.resource)
    assert.deepStrictEqual(resources.sort(), [sql, transaction].sort())
  })
}

function assertClusterMetadata (assertAutomaticRemoval = false) {
  const metadataByResource = new Map()

  return agent.assertSomeTraces(traces => {
    for (const span of traces.flat()) {
      if (span.resource.startsWith('SELECT') && span.resource.endsWith('AS cluster_metadata')) {
        metadataByResource.set(span.resource, span.meta)
      }
    }

    assert.strictEqual(metadataByResource.size, assertAutomaticRemoval ? 4 : 3,
      'cluster metadata spans have not all flushed yet')
    assert.strictEqual(metadataByResource.get('SELECT 7 AS cluster_metadata')['db.name'], undefined)
    assert.strictEqual(metadataByResource.get('SELECT 8 AS cluster_metadata')['db.name'], undefined)
    assert.strictEqual(metadataByResource.get('SELECT 9 AS cluster_metadata')['db.name'], 'db')
    if (assertAutomaticRemoval) {
      assert.strictEqual(metadataByResource.get('SELECT 10 AS cluster_metadata')['db.name'], undefined)
    }
  })
}

describe('Plugin', () => {
  describe('mariadb', () => {
    withVersions('mariadb', 'mariadb', range, (version, _, resolvedVersion) => {
      let tracer

      describe('without configuration - callbacks', () => {
        let mariadb
        let connection

        afterEach((done) => {
          connection.end(() => {
            agent.close().then(done)
          })
        })

        beforeEach(async () => {
          tracer = await agent.load('mariadb')
          mariadb = loadMariadb(version, resolvedVersion, 'mariadb/callback')

          connection = mariadb.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db',
          })

          return new Promise((resolve, reject) => {
            connection.connect(err => {
              if (err) {
                reject(err)
              } else {
                resolve(connection)
              }
            })
          })
        })

        withNamingSchema(
          done => connection.query('SELECT 1', (_) => { }),
          rawExpectedSchema.outbound
        )

        withPeerService(
          () => tracer,
          'mariadb',
          done => connection.query('SELECT 1', done),
          'db',
          'db.name'
        )

        it('should propagate context to callbacks, with correct callback args', done => {
          const span = tracer.startSpan('test')

          tracer.scope().activate(span, () => {
            const span = tracer.scope().active()

            connection.query('SELECT 1 + 1 AS solution', (err, results, fields) => {
              try {
                assert.notStrictEqual(results, null)
                assert.notStrictEqual(fields, null)
                assert.strictEqual(tracer.scope().active(), span)
              } catch (e) {
                done(e)
              }
              done()
            })
          })
        })

        it('should run the callback in the parent context', done => {
          connection.query('SELECT 1 + 1 AS solution', () => {
            assert.strictEqual(tracer.scope().active(), null)
            done()
          })
        })

        it('should run event listeners in the parent context', done => {
          const query = connection.query('SELECT 1 + 1 AS solution')

          query.on('end', () => {
            assert.strictEqual(tracer.scope().active(), null)
            done()
          })
        })

        it('should do automatic instrumentation', done => {
          agent.assertFirstTraceSpan({
            name: expectedSchema.outbound.opName,
            service: expectedSchema.outbound.serviceName,
            resource: 'SELECT 1 + 1 AS solution',
            type: 'sql',
            meta: {
              'span.kind': 'client',
              'db.name': 'db',
              'db.user': 'root',
              'db.type': 'mariadb',
              component: 'mariadb',
              '_dd.integration': 'mariadb',
            },
          }, { spanResourceMatch: /SELECT 1 \+ 1 AS solution/ })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution', (error, results, fields) => {
            if (error) throw error
          })
        })

        if (semver.intersects(version, '>=3')) {
          it('should support prepared statement shorthand', done => {
            agent.assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'SELECT ? + ? AS solution',
              type: 'sql',
              meta: {
                'span.kind': 'client',
                'db.name': 'db',
                'db.user': 'root',
                'db.type': 'mariadb',
                component: 'mariadb',
              },
            }, { spanResourceMatch: /SELECT \? \+ \? AS solution/ })
              .then(done)
              .catch(done)

            connection.execute('SELECT ? + ? AS solution', [1, 1], (error, results, fields) => {
              if (error) throw error
            })
          })

          it('should support prepared statements', done => {
            agent.assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'SELECT ? + ? AS solution',
              type: 'sql',
              meta: {
                'span.kind': 'client',
                'db.name': 'db',
                'db.user': 'root',
                'db.type': 'mariadb',
                component: 'mariadb',
              },
            }, { spanResourceMatch: /SELECT \? \+ \? AS solution/ })
              .then(done)
              .catch(done)

            connection.prepare('SELECT ? + ? AS solution', (err, statement) => {
              if (err) throw err

              statement.execute([1, 1], (error, rows, columns) => {
                if (error) throw error
              })

              statement.close()
            })
          })

          it('should support prepared statements without callbacks', async () => {
            const statement = await new Promise((resolve, reject) => {
              connection.prepare('SELECT ? + ? AS solution', (error, statement) => {
                if (error) return reject(error)
                resolve(statement)
              })
            })

            await Promise.all([
              agent.assertFirstTraceSpan({ resource: 'SELECT ? + ? AS solution' }, {
                spanResourceMatch: /SELECT \? \+ \? AS solution/,
              }),
              statement.execute([1, 1]),
            ])

            statement.close()
          })
        }

        if (semver.gte(resolvedVersion, '3.5.3')) {
          it('should trace object-form SQL', async () => {
            const query = (method, sql, values) => new Promise((resolve, reject) => {
              connection[method]({ sql }, values, error => error ? reject(error) : resolve())
            })

            await Promise.all([
              agent.assertFirstTraceSpan({ resource: 'SELECT 1 AS object_query' }),
              query('query', 'SELECT 1 AS object_query'),
            ])
            await Promise.all([
              agent.assertFirstTraceSpan({ resource: 'SELECT ? AS object_execute' }),
              query('execute', 'SELECT ? AS object_execute', [1]),
            ])
          })

          it('should trace query and prepared statement streams', async () => {
            const statement = await new Promise((resolve, reject) => {
              connection.prepare('SELECT ? AS prepared_stream', (error, statement) => {
                if (error) return reject(error)
                resolve(statement)
              })
            })

            try {
              await Promise.all([
                agent.assertFirstTraceSpan({ resource: 'SELECT 1 AS query_stream' }),
                consumeStream(connection.queryStream('SELECT 1 AS query_stream')),
              ])
              await Promise.all([
                agent.assertFirstTraceSpan({ resource: 'SELECT ? AS prepared_stream' }),
                consumeStream(statement.executeStream([1])),
              ])
            } finally {
              statement.close()
            }
          })

          it('should normalize URL connection options', async () => {
            const uriConnection = mariadb.createConnection('mariadb://root@localhost/db')
            await new Promise((resolve, reject) => {
              uriConnection.connect(error => error ? reject(error) : resolve())
            })

            try {
              await Promise.all([
                agent.assertFirstTraceSpan({
                  resource: 'SELECT 1 AS url_options',
                  meta: {
                    'db.name': 'db',
                    'db.user': 'root',
                    'out.host': 'localhost',
                  },
                }),
                new Promise((resolve, reject) => {
                  uriConnection.query('SELECT 1 AS url_options', error => error ? reject(error) : resolve())
                }),
              ])
            } finally {
              await new Promise((resolve, reject) => {
                uriConnection.end(error => error ? reject(error) : resolve())
              })
            }
          })

          it('should support transaction helpers', async () => {
            const call = method => new Promise((resolve, reject) => {
              connection[method](error => error ? reject(error) : resolve())
            })
            const assertion = assertTransactionSpans()
            const span = tracer.startSpan('test')

            await tracer.scope().activate(span, async () => {
              await call('beginTransaction')
              await call('commit')
              await call('beginTransaction')
              await call('rollback')
            })

            span.finish()
            await assertion
          })

          it('should trace transaction helpers queued behind transaction starts', async () => {
            const callPair = method => new Promise((resolve, reject) => {
              let pending = 2
              const callback = error => {
                if (error) return reject(error)
                if (--pending === 0) resolve()
              }

              connection.beginTransaction(callback)
              connection[method](callback)
            })
            const assertion = assertTransactionSpans()
            const span = tracer.startSpan('test')

            await tracer.scope().activate(span, async () => {
              await callPair('commit')
              await callPair('rollback')
            })

            span.finish()
            await assertion
          })

          it('should trace transaction helpers queued behind queries', async () => {
            const assertion = assertQueuedTransactionSpan('SELECT SLEEP(0.1)', 'COMMIT')
            const span = tracer.startSpan('test')

            await tracer.scope().activate(span, () => new Promise((resolve, reject) => {
              let pending = 2
              const callback = error => {
                if (error) return reject(error)
                if (--pending === 0) resolve()
              }
              connection.query('SELECT SLEEP(0.1)', callback)
              connection.commit(callback)
            }))

            span.finish()
            await assertion
          })

          it('should not trace transaction helpers when no command is sent', async () => {
            const assertion = agent.assertNoTraces(traces => {
              const transactionSpan = traces.flat()
                .find(span => span.resource === 'COMMIT' || span.resource === 'ROLLBACK')
              assert.strictEqual(transactionSpan, undefined)
            })

            await new Promise((resolve, reject) => connection.commit(error => error ? reject(error) : resolve()))
            await new Promise((resolve, reject) => connection.rollback(error => error ? reject(error) : resolve()))
            await assertion
          })

          it('should support pool clusters', async () => {
            const cluster = mariadb.createPoolCluster()
            cluster.add('primary', {
              host: 'localhost',
              user: 'root',
              database: 'db',
            })

            try {
              await Promise.all([
                agent.assertFirstTraceSpan({ resource: 'SELECT 7 AS cluster_query' }),
                new Promise((resolve, reject) => {
                  cluster.of('primary').query('SELECT 7 AS cluster_query', error => {
                    if (error) return reject(error)
                    resolve()
                  })
                }),
              ])
            } finally {
              await new Promise((resolve, reject) => cluster.end(error => error ? reject(error) : resolve()))
            }
          })

          it('should not guess options for ambiguous or removed cluster nodes', async () => {
            const cluster = mariadb.createPoolCluster()
            cluster.add('node-1', { host: 'localhost', user: 'root', database: 'db' })
            cluster.add('node-2', { host: 'localhost', user: 'root' })
            const filteredCluster = cluster.of('^node-', 'RR')
            const query = sql => new Promise((resolve, reject) => {
              filteredCluster.query(sql, error => error ? reject(error) : resolve())
            })
            const assertion = assertClusterMetadata()

            try {
              await query('SELECT 7 AS cluster_metadata')
              await query('SELECT 8 AS cluster_metadata')
              cluster.remove('^node-')
              cluster.add('node-3', { host: 'localhost', user: 'root', database: 'db' })
              await new Promise((resolve, reject) => {
                cluster.of('^node-').query(
                  'SELECT 9 AS cluster_metadata',
                  error => error ? reject(error) : resolve()
                )
              })
              await assertion
            } finally {
              await new Promise((resolve, reject) => cluster.end(error => error ? reject(error) : resolve()))
            }
          })
        }

        it('should handle errors', done => {
          let error

          agent
            .assertSomeTraces(traces => {
              assertObjectContains(traces[0][0].meta, {
                [ERROR_TYPE]: error.name,
                [ERROR_MESSAGE]: error.message,
                [ERROR_STACK]: error.stack,
                component: 'mariadb',
              })
            })
            .then(done)
            .catch(done)

          connection.query('INVALID', (err, results, fields) => {
            error = err
          })
        })

        it('should work without a callback', done => {
          agent
            .assertFirstTraceSpan({ resource: 'SELECT 1 + 1 AS solution' },
              { spanResourceMatch: /SELECT 1 \+ 1 AS solution/ })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution')
        })
      })

      if (semver.intersects(version, '>=3')) {
        describe('without configuration - promises', () => {
          let mariadb
          let connection

          afterEach(async () => {
            await connection.end()
            await agent.close()
          })

          beforeEach(async () => {
            tracer = await agent.load('mariadb')
            mariadb = loadMariadb(version, resolvedVersion, 'mariadb')

            connection = await mariadb.createConnection({
              host: 'localhost',
              user: 'root',
              database: 'db',
            })
          })

          withNamingSchema(
            () => connection.query('SELECT 1'),
            rawExpectedSchema.outbound
          )

          withPeerService(
            () => tracer,
            'mariadb',
            () => connection.query('SELECT 1'),
            'db',
            'db.name'
          )

          it('should propagate context to promise continuations', async () => {
            const span = tracer.startSpan('test')

            await tracer.scope().activate(span, () => {
              return connection.query('SELECT 1 + 1 AS solution').then((results) => {
                assert.notStrictEqual(results, null)
                assert.strictEqual(tracer.scope().active(), span)
              })
            })
          })

          it('should run promise continuations in the parent context', async () => {
            await connection.query('SELECT 1 + 1 AS solution').then(() => {
              assert.strictEqual(tracer.scope().active(), null)
            })
          })

          it('should run event listeners in the parent context', done => {
            if (typeof connection.queryStream !== 'function') return this.skip()

            const stream = connection.queryStream('SELECT 1 + 1 AS solution')

            stream.once('error', done)
            stream.once('end', () => {
              assert.strictEqual(tracer.scope().active(), null)
              done()
            })

            stream.resume()
          })

          it('should do automatic instrumentation', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: expectedSchema.outbound.serviceName,
                resource: 'SELECT 1 + 1 AS solution',
                type: 'sql',
                meta: {
                  'span.kind': 'client',
                  'db.name': 'db',
                  'db.user': 'root',
                  'db.type': 'mariadb',
                  component: 'mariadb',
                  '_dd.integration': 'mariadb',
                },
              }, { spanResourceMatch: /SELECT 1 \+ 1 AS solution/ }),
              connection.query('SELECT 1 + 1 AS solution'),
            ])
          })

          it('should work without a callback', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({ resource: 'SELECT 1 + 1 AS solution' }),
              connection.query('SELECT 1 + 1 AS solution'),
            ])
          })

          it('should support prepared statement shorthand', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: expectedSchema.outbound.serviceName,
                resource: 'SELECT ? + ? AS solution',
                type: 'sql',
                meta: {
                  'span.kind': 'client',
                  'db.name': 'db',
                  'db.user': 'root',
                  'db.type': 'mariadb',
                  component: 'mariadb',
                },
              }, { spanResourceMatch: /SELECT \? \+ \? AS solution/ }),
              connection.execute('SELECT ? + ? AS solution', [1, 1]),
            ])
          })

          it('should support prepared statements', async () => {
            const statement = await connection.prepare('SELECT ? + ? AS solution')

            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: expectedSchema.outbound.serviceName,
                resource: 'SELECT ? + ? AS solution',
                type: 'sql',
                meta: {
                  'span.kind': 'client',
                  'db.name': 'db',
                  'db.user': 'root',
                  'db.type': 'mariadb',
                  component: 'mariadb',
                },
              }, { spanResourceMatch: /SELECT \? \+ \? AS solution/ }),
              statement.execute([1, 1]),
            ])

            await statement.close()
          })

          if (semver.gte(resolvedVersion, '3.5.3')) {
            it('should trace object-form SQL', async () => {
              await Promise.all([
                agent.assertFirstTraceSpan({ resource: 'SELECT 1 AS object_query' }),
                connection.query({ sql: 'SELECT 1 AS object_query' }),
              ])
              await Promise.all([
                agent.assertFirstTraceSpan({ resource: 'SELECT ? AS object_execute' }),
                connection.execute({ sql: 'SELECT ? AS object_execute' }, [1]),
              ])

              const statement = await connection.prepare({ sql: 'SELECT ? AS object_prepare' })
              try {
                await Promise.all([
                  agent.assertFirstTraceSpan({ resource: 'SELECT ? AS object_prepare' }),
                  statement.execute([1]),
                ])
              } finally {
                await statement.close()
              }
            })

            it('should finish a synchronously failing command', async () => {
              const assertion = agent.assertSomeTraces(traces => {
                const trace = traces.find(trace => trace.some(span => span.name === 'test'))
                assert.ok(trace, 'synchronous failure trace has not flushed yet')
                assert.strictEqual(trace.filter(span => span.meta.component === 'mariadb').length, 1)
              })
              const span = tracer.startSpan('test')

              tracer.scope().activate(span, () => {
                assert.throws(() => connection.query(null))
                assert.strictEqual(tracer.scope().active(), span)
              })
              span.finish()

              await assertion
            })

            it('should trace query and prepared statement streams', async () => {
              const statement = await connection.prepare('SELECT ? AS prepared_stream')

              try {
                await Promise.all([
                  agent.assertFirstTraceSpan({ resource: 'SELECT 1 AS query_stream' }),
                  consumeStream(connection.queryStream('SELECT 1 AS query_stream')),
                ])
                await Promise.all([
                  agent.assertFirstTraceSpan({ resource: 'SELECT ? AS prepared_stream' }),
                  consumeStream(statement.executeStream([1])),
                ])
              } finally {
                await statement.close()
              }
            })

            it('should normalize URL connection options', async () => {
              const uriConnection = await mariadb.createConnection('mariadb://root@localhost/db')

              try {
                await Promise.all([
                  agent.assertFirstTraceSpan({
                    resource: 'SELECT 1 AS url_options',
                    meta: {
                      'db.name': 'db',
                      'db.user': 'root',
                      'out.host': 'localhost',
                    },
                  }),
                  uriConnection.query('SELECT 1 AS url_options'),
                ])
              } finally {
                await uriConnection.end()
              }
            })

            it('should support transaction helpers', async () => {
              const assertion = assertTransactionSpans()
              const span = tracer.startSpan('test')

              await tracer.scope().activate(span, async () => {
                await connection.beginTransaction()
                await connection.commit()
                await connection.beginTransaction()
                await connection.rollback()
              })

              span.finish()
              await assertion
            })

            it('should trace transaction helpers queued behind transaction starts', async () => {
              const callPair = method => Promise.all([
                connection.beginTransaction(),
                connection[method](),
              ])
              const assertion = assertTransactionSpans()
              const span = tracer.startSpan('test')

              await tracer.scope().activate(span, async () => {
                await callPair('commit')
                await callPair('rollback')
              })

              span.finish()
              await assertion
            })

            it('should trace transaction helpers queued behind queries', async () => {
              const assertion = assertQueuedTransactionSpan('SELECT SLEEP(0.1)', 'COMMIT')
              const span = tracer.startSpan('test')

              await tracer.scope().activate(span, () => Promise.all([
                connection.query('SELECT SLEEP(0.1)'),
                connection.commit(),
              ]))

              span.finish()
              await assertion
            })

            it('should trace transaction helpers queued behind prepared statements', async () => {
              const sql = 'SELECT SLEEP(?) AS prepared_wait'
              const statement = await connection.prepare(sql)
              const assertion = assertQueuedTransactionSpan(sql, 'ROLLBACK')
              const span = tracer.startSpan('test')

              try {
                await tracer.scope().activate(span, () => Promise.all([
                  statement.execute([0.1]),
                  connection.rollback(),
                ]))
              } finally {
                span.finish()
                await statement.close()
              }

              await assertion
            })

            it('should retain transaction tracking until every concurrent command finishes', async () => {
              const assertion = agent.assertSomeTraces(traces => {
                const trace = traces.find(trace => trace.some(span => span.name === 'test'))
                assert.ok(trace, 'concurrent command trace has not flushed yet')
                const resources = trace
                  .filter(span => span.meta.component === 'mariadb')
                  .map(span => span.resource)
                  .sort()
                assert.deepStrictEqual(resources, [
                  'COMMIT',
                  'SELECT SLEEP(0.01) AS first_command',
                  'SELECT SLEEP(0.1) AS second_command',
                ])
              })
              const span = tracer.startSpan('test')

              await tracer.scope().activate(span, async () => {
                const first = connection.query('SELECT SLEEP(0.01) AS first_command')
                const second = connection.query('SELECT SLEEP(0.1) AS second_command')
                await first
                await Promise.all([second, connection.commit()])
              })

              span.finish()
              await assertion
            })

            it('should tag stream errors', async () => {
              const stream = connection.queryStream('SELECT * FROM definitely_missing_stream_table')
              const query = new Promise(resolve => {
                stream.once('error', resolve)
                stream.resume()
              })

              await Promise.all([
                agent.assertFirstTraceSpan({
                  resource: 'SELECT * FROM definitely_missing_stream_table',
                  meta: {
                    [ERROR_TYPE]: ANY_STRING,
                    [ERROR_MESSAGE]: ANY_STRING,
                    [ERROR_STACK]: ANY_STRING,
                  },
                }),
                query,
              ])
            })

            it('should not trace transaction helpers when no command is sent', async () => {
              const assertion = agent.assertNoTraces(traces => {
                const transactionSpan = traces.flat()
                  .find(span => span.resource === 'COMMIT' || span.resource === 'ROLLBACK')
                assert.strictEqual(transactionSpan, undefined)
              })

              await connection.commit()
              await connection.rollback()
              await assertion
            })

            it('should support pool clusters', async () => {
              const cluster = mariadb.createPoolCluster()
              cluster.add('primary', {
                host: 'localhost',
                user: 'root',
                database: 'db',
              })

              try {
                await Promise.all([
                  agent.assertFirstTraceSpan({ resource: 'SELECT 7 AS cluster_query' }),
                  cluster.of('primary').query('SELECT 7 AS cluster_query'),
                ])
              } finally {
                await cluster.end()
              }
            })

            it('should use the default cluster selector for false', async () => {
              const cluster = mariadb.createPoolCluster()
              cluster.add('primary', { host: 'localhost', user: 'root', database: 'db' })

              try {
                await Promise.all([
                  agent.assertFirstTraceSpan({
                    resource: 'SELECT 1 AS false_selector',
                    meta: { 'db.name': 'db' },
                  }),
                  cluster.getConnection(false).then(async connection => {
                    try {
                      await connection.query('SELECT 1 AS false_selector')
                    } finally {
                      await connection.end()
                    }
                  }),
                ])
              } finally {
                await cluster.end()
              }
            })

            it('should remove instrumentation listeners when a pool cluster ends', async () => {
              const cluster = mariadb.createPoolCluster()
              const removeListenerCount = cluster.listenerCount('remove')

              await cluster.end()

              assert.strictEqual(cluster.listenerCount('remove'), removeListenerCount - 1)
            })

            it('should not guess options for ambiguous or removed cluster nodes', async () => {
              const cluster = mariadb.createPoolCluster()
              cluster.add('node-1', { host: 'localhost', user: 'root', database: 'db' })
              cluster.add('node-2', { host: 'localhost', user: 'root' })
              const filteredCluster = cluster.of('^node-', 'RR')
              const assertion = assertClusterMetadata(true)

              try {
                await filteredCluster.query('SELECT 7 AS cluster_metadata')
                await filteredCluster.query('SELECT 8 AS cluster_metadata')
                cluster.remove('^node-')
                cluster.add('node-3', { host: 'localhost', user: 'root', database: 'db' })
                await cluster.of('^node-').query('SELECT 9 AS cluster_metadata')
                cluster.emit('remove', 'node-3')
                await cluster.of('^node-3$').query('SELECT 10 AS cluster_metadata')
                await assertion
              } finally {
                await cluster.end()
              }
            })
          }

          it('should handle errors', async () => {
            const queryPromise = connection.query('SELECT * FROM definitely_missing_table').catch(() => {})

            await Promise.all([
              agent.assertFirstTraceSpan({
                resource: 'SELECT * FROM definitely_missing_table',
                meta: {
                  component: 'mariadb',
                  [ERROR_TYPE]: ANY_STRING,
                  [ERROR_MESSAGE]: ANY_STRING,
                  [ERROR_STACK]: ANY_STRING,
                },
              }, { spanResourceMatch: /definitely_missing_table/ }),
              queryPromise,
            ])
          })
        })
      }

      if (semver.intersects(version, '>=2.5.2 <3')) {
        describe('without configuration - promise rejection tagging (<3)', () => {
          let mariadb
          let connection

          afterEach(async () => {
            await connection.end()
            await agent.close()
          })

          beforeEach(async () => {
            tracer = await agent.load('mariadb')
            mariadb = loadMariadb(version, resolvedVersion, 'mariadb')
            connection = await mariadb.createConnection({
              host: 'localhost',
              user: 'root',
              database: 'db',
            })
          })

          it('should tag promise rejections with error details', async () => {
            let error

            const assertion = agent.assertSomeTraces(traces => {
              if (!error) throw new Error('Expected error to be set')

              assertObjectContains(traces[0][0].meta, {
                [ERROR_TYPE]: error.name,
                [ERROR_MESSAGE]: error.message,
                [ERROR_STACK]: error.stack,
                component: 'mariadb',
              })
            }, { spanResourceMatch: /definitely_missing_table/ })

            // For >=2.5.2 <3, mariadb uses `_queryPromise` internally for promise queries.
            await connection._queryPromise('SELECT * FROM definitely_missing_table').catch((e) => { error = e })

            await assertion
          })
        })
      }

      describe('with configuration - callbacks', () => {
        let connection
        let mariadb

        afterEach((done) => {
          connection.end(() => {
            agent.close().then(done)
          })
        })

        beforeEach(async () => {
          tracer = await agent.load('mariadb', { service: 'custom' })
          mariadb = loadMariadb(version, resolvedVersion, 'mariadb/callback')

          connection = mariadb.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db',
          })

          return new Promise((resolve, reject) => {
            connection.connect(err => {
              if (err) {
                reject(err)
              } else {
                resolve(connection)
              }
            })
          })
        })

        it('should be configured with the correct values', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].service, 'custom')
            })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution')
        })

        withNamingSchema(
          () => connection.query('SELECT 1 + 1 AS solution'),
          {
            v0: {
              opName: 'mariadb.query',
              serviceName: 'custom',
            },
            v1: {
              opName: 'mariadb.query',
              serviceName: 'custom',
            },
          }
        )
      })

      if (semver.intersects(version, '>=3')) {
        describe('with configuration - promises', () => {
          let connection
          let mariadb

          afterEach(async () => {
            await connection.end()
            await agent.close()
          })

          beforeEach(async () => {
            tracer = await agent.load('mariadb', { service: 'custom' })
            mariadb = loadMariadb(version, resolvedVersion, 'mariadb')

            connection = await mariadb.createConnection({
              host: 'localhost',
              user: 'root',
              database: 'db',
            })
          })

          it('should be configured with the correct values', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({ service: 'custom' }, { spanResourceMatch: /SELECT 1 \+ 1 AS solution/ }),
              connection.query('SELECT 1 + 1 AS solution'),
            ])
          })

          withNamingSchema(
            () => connection.query('SELECT 1 + 1 AS solution'),
            {
              v0: {
                opName: 'mariadb.query',
                serviceName: 'custom',
              },
              v1: {
                opName: 'mariadb.query',
                serviceName: 'custom',
              },
            }
          )
        })
      }

      describe('with service configured as function - callbacks', () => {
        const serviceSpy = sinon.stub().returns('custom')
        let connection
        let mariadb

        afterEach((done) => {
          connection.end(() => {
            agent.close().then(done)
          })
        })

        beforeEach(async () => {
          tracer = await agent.load('mariadb', { service: serviceSpy })
          mariadb = loadMariadb(version, resolvedVersion, 'mariadb/callback')

          connection = mariadb.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db',
          })

          return new Promise((resolve, reject) => {
            connection.connect(err => {
              if (err) {
                reject(err)
              } else {
                resolve(connection)
              }
            })
          })
        })

        withNamingSchema(
          () => connection.query('SELECT 1 + 1 AS solution', () => {}),
          {
            v0: {
              opName: 'mariadb.query',
              serviceName: 'custom',
            },
            v1: {
              opName: 'mariadb.query',
              serviceName: 'custom',
            },
          }
        )

        it('should be configured with the correct values', done => {
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].service, 'custom')
            sinon.assert.calledWith(serviceSpy, sinon.match({
              host: 'localhost',
              user: 'root',
              database: 'db',
            }))
            done()
          })

          connection.query('SELECT 1 + 1 AS solution', () => {})
        })
      })

      if (semver.intersects(version, '>=3')) {
        describe('with service configured as function - promises', () => {
          const serviceSpy = sinon.stub().returns('custom')
          let connection
          let mariadb

          afterEach(async () => {
            await connection.end()
            await agent.close()
          })

          beforeEach(async () => {
            tracer = await agent.load('mariadb', { service: serviceSpy })
            mariadb = loadMariadb(version, resolvedVersion, 'mariadb')

            connection = await mariadb.createConnection({
              host: 'localhost',
              user: 'root',
              database: 'db',
            })
          })

          withNamingSchema(
            () => connection.query('SELECT 1 + 1 AS solution'),
            {
              v0: {
                opName: 'mariadb.query',
                serviceName: 'custom',
              },
              v1: {
                opName: 'mariadb.query',
                serviceName: 'custom',
              },
            }
          )

          it('should be configured with the correct values', async () => {
            await Promise.all([
              agent.assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].service, 'custom')
                sinon.assert.calledWith(serviceSpy, sinon.match({
                  host: 'localhost',
                  user: 'root',
                  database: 'db',
                }))
              }, { spanResourceMatch: /SELECT 1 \+ 1 AS solution/ }),
              connection.query('SELECT 1 + 1 AS solution'),
            ])
          })
        })
      }

      describe('with a connection pool - callbacks', () => {
        let pool
        let mariadb

        afterEach((done) => {
          pool.end(() => {
            agent.close().then(done)
          })
        })

        beforeEach(async () => {
          tracer = await agent.load('mariadb')
          mariadb = loadMariadb(version, resolvedVersion, 'mariadb/callback')

          pool = mariadb.createPool({
            connectionLimit: 1,
            host: 'localhost',
            user: 'root',
          })
        })

        it('should do automatic instrumentation', done => {
          agent.assertFirstTraceSpan({
            name: expectedSchema.outbound.opName,
            service: expectedSchema.outbound.serviceName,
            resource: 'SELECT 1 + 1 AS solution',
            type: 'sql',
            meta: {
              'span.kind': 'client',
              'db.user': 'root',
              'db.type': 'mariadb',
              component: 'mariadb',
            },
          })
            .then(done)
            .catch(done)

          pool.query('SELECT 1 + 1 AS solution')
        })

        if (semver.gte(resolvedVersion, '3.5.3')) {
          it('should instrument connections exposed by the pool connection event', done => {
            agent.assertFirstTraceSpan({ resource: 'SELECT 1 AS event_connection' }).then(done, done)

            pool.once('connection', connection => {
              connection.query('SELECT 1 AS event_connection', error => {
                if (error) done(error)
              })
            })
            pool.getConnection((error, connection) => {
              if (error) return done(error)
              connection.end()
            })
          })
        }

        it('should run the callback in the parent context', done => {
          pool.query('SELECT 1 + 1 AS solution', () => {
            assert.strictEqual(tracer.scope().active(), null)
            done()
          })
        })

        it('should propagate context to callbacks', done => {
          const span1 = tracer.startSpan('test1')
          const span2 = tracer.startSpan('test2')

          tracer.trace('test', () => {
            tracer.scope().activate(span1, () => {
              pool.query('SELECT 1 + 1 AS solution', () => {
                assert.deepStrictEqual(tracer.scope().active() === span1, true)
                tracer.scope().activate(span2, () => {
                  pool.query('SELECT 1 + 1 AS solution', () => {
                    assert.deepStrictEqual(tracer.scope().active() === span2, true)
                    done()
                  })
                })
              })
            })
          })
        })

        it('runs a queued pool query callback in its own caller context', done => {
          const span1 = tracer.startSpan('test1')
          const span2 = tracer.startSpan('test2')
          let pending = 2

          const check = expected => error => {
            if (error) {
              done(error)
              return
            }
            try {
              assert.strictEqual(tracer.scope().active(), expected)
            } catch (assertionError) {
              done(assertionError)
              return
            }
            if (--pending === 0) {
              done()
            }
          }

          // Both queries are dispatched in the same tick with `connectionLimit: 1`, so the second
          // waits in the pool's connection queue and its callback fires from the first query's
          // release flow — the async context that drops without the getConnection wrap.
          tracer.trace('test', () => {
            tracer.scope().activate(span1, () => {
              pool.query('SELECT 1 AS one', check(span1))
            })
            tracer.scope().activate(span2, () => {
              pool.query('SELECT 2 AS two', check(span2))
            })
          })
        })
      })

      if (semver.intersects(version, '>=3')) {
        describe('with a connection pool - promises', () => {
          let pool
          let mariadb

          afterEach(async () => {
            await pool.end()
            await agent.close()
          })

          beforeEach(async () => {
            tracer = await agent.load('mariadb')
            mariadb = loadMariadb(version, resolvedVersion, 'mariadb')

            pool = mariadb.createPool({
              connectionLimit: 1,
              host: 'localhost',
              user: 'root',
            })
          })

          it('should do automatic instrumentation', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: expectedSchema.outbound.serviceName,
                resource: 'SELECT 1 + 1 AS solution',
                type: 'sql',
                meta: {
                  'span.kind': 'client',
                  'db.user': 'root',
                  'db.type': 'mariadb',
                  component: 'mariadb',
                },
              }, { spanResourceMatch: /SELECT 1 \+ 1 AS solution/ }),
              pool.query('SELECT 1 + 1 AS solution'),
            ])
          })

          if (semver.gte(resolvedVersion, '3.5.3')) {
            it('should instrument connections exposed by the pool connection event', async () => {
              const query = new Promise((resolve, reject) => {
                pool.once('connection', connection => {
                  connection.query('SELECT 1 AS event_connection').then(resolve, reject)
                })
              })

              const connection = await pool.getConnection()
              await Promise.all([
                agent.assertFirstTraceSpan({ resource: 'SELECT 1 AS event_connection' }),
                query,
              ])
              await connection.end()
            })
          }

          it('should run promise continuations in the parent context', async () => {
            await pool.query('SELECT 1 + 1 AS solution').then(() => {
              assert.strictEqual(tracer.scope().active(), null)
            })
          })

          it('should propagate context to promise continuations', async () => {
            const span1 = tracer.startSpan('test1')
            const span2 = tracer.startSpan('test2')

            await tracer.trace('test', () => {
              return tracer.scope().activate(span1, () => {
                return pool.query('SELECT 1 + 1 AS solution').then(() => {
                  assert.deepStrictEqual(tracer.scope().active() === span1, true)
                  return tracer.scope().activate(span2, () => {
                    return pool.query('SELECT 1 + 1 AS solution').then(() => {
                      assert.deepStrictEqual(tracer.scope().active() === span2, true)
                    })
                  })
                })
              })
            })
          })
        })
      }

      describe('with a connection pool started during a request - callbacks', () => {
        let pool
        let mariadb

        afterEach((done) => {
          pool.end(() => {
            agent.close().then(done)
          })
        })

        beforeEach(async () => {
          tracer = await agent.load(['mariadb', 'net'])
          mariadb = loadMariadb(version, resolvedVersion, 'mariadb/callback')
        })

        it('should not instrument connections to avoid leaks from internal queue', done => {
          assertNoConnectionSpanLeak().then(done, done)

          const span = tracer.startSpan('test')

          tracer.scope().activate(span, () => {
            pool = pool || mariadb.createPool({
              host: 'localhost',
              user: 'root',
              database: 'db',
              connectionLimit: 3,
              idleTimeout: 1,
              minimumIdle: 1,
            })

            pool.getConnection((err, conn) => {
              if (err) return done(err)
              conn.query('SELECT 1 + 1 AS solution', (err, results) => {
                if (err) return done(err)
                conn.end()
                span.finish()
              })
            })
          })
        })

        if (semver.gte(resolvedVersion, '3.5.3')) {
          it('should not leak cluster minimum-idle connections into the active trace', done => {
            assertNoConnectionSpanLeak().then(done, done)
            const span = tracer.startSpan('test')

            tracer.scope().activate(span, () => {
              pool = mariadb.createPoolCluster()
              pool.add('primary', {
                host: 'localhost',
                user: 'root',
                database: 'db',
                minimumIdle: 1,
              })
              pool.getConnection('primary', (error, connection) => {
                if (error) return done(error)
                connection.query('SELECT 1 AS cluster_setup', error => {
                  connection.end()
                  if (error) return done(error)
                  span.finish()
                })
              })
            })
          })
        }
      })

      if (semver.intersects(version, '>=3')) {
        describe('with a connection pool started during a request - promises', () => {
          let pool
          let mariadb

          afterEach(async () => {
            await pool.end()
            await agent.close()
          })

          beforeEach(async () => {
            tracer = await agent.load(['mariadb', 'net'])
            mariadb = loadMariadb(version, resolvedVersion, 'mariadb')
          })

          it('should not instrument connections to avoid leaks from internal queue', async () => {
            const span = tracer.startSpan('test')

            const assertion = assertNoConnectionSpanLeak()

            await tracer.scope().activate(span, async () => {
              pool = pool || mariadb.createPool({
                host: 'localhost',
                user: 'root',
                database: 'db',
                connectionLimit: 3,
                idleTimeout: 1,
                minimumIdle: 1,
              })

              const conn = await pool.getConnection()
              await conn.query('SELECT 1 + 1 AS solution')
              await conn.end()
              span.finish()
            })

            await assertion
          })

          if (semver.gte(resolvedVersion, '3.5.3')) {
            it('should not leak cluster minimum-idle connections into the active trace', async () => {
              const assertion = assertNoConnectionSpanLeak()
              const span = tracer.startSpan('test')

              await tracer.scope().activate(span, async () => {
                pool = mariadb.createPoolCluster()
                pool.add('primary', {
                  host: 'localhost',
                  user: 'root',
                  database: 'db',
                  minimumIdle: 1,
                })
                const connection = await pool.getConnection('primary')
                await connection.query('SELECT 1 AS cluster_setup')
                await connection.end()
                span.finish()
              })

              await assertion
            })
          }
        })
      }
    })
  })
})
