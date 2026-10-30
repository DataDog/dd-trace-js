'use strict'

const assert = require('node:assert/strict')
const dc = require('node:diagnostics_channel')
const net = require('node:net')
const { inspect } = require('node:util')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const semver = require('semver')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { ANY_STRING, assertObjectContains } = require('../../../integration-tests/helpers')
const { withFakeNow, withoutImmediateClockRead } = require('./helpers')
const { expectedSchema, rawExpectedSchema } = require('./naming')

// https://github.com/mariadb-corporation/mariadb-connector-nodejs/commit/0a90b71ab20ab4e8b6a86a77ba291bba8ba6a34e
const lowerBound = semver.gte(process.version, '15.0.0') ? '>=2.5.1' : '>=2'
// MariaDB 3.5.1 and 3.5.2 are ESM-only, so they are exercised by the ESM integration test below.
const range = `${lowerBound} <3.5.1`

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

describe('Plugin', () => {
  describe('mariadb', () => {
    withVersions('mariadb', 'mariadb', range, version => {
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
          mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb/callback')

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
            mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb')

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
            mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb')
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
          mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb/callback')

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
            mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb')

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
          mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb/callback')

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
            mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb')

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
          mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb/callback')

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

        if (semver.intersects(version, '>=3.4.1')) {
          it('records the pool acquire wait time on a callback pooled query span', async () => {
            await Promise.all([
              agent.assertSomeTraces(traces => {
                const span = traces[0][0]

                assert.strictEqual(typeof span.metrics['mariadb.pool.wait_time'], 'number')
                assert.ok(span.metrics['mariadb.pool.wait_time'] >= 0)
                assert.strictEqual(traces[0].find(span => span.name === 'mariadb.pool.acquire'), undefined)
              }, { spanResourceMatch: /^SELECT 4 AS callback_pool_wait$/ }),
              new Promise((resolve, reject) => {
                pool.query('SELECT 4 AS callback_pool_wait', error => error ? reject(error) : resolve())
              }),
            ])
          })

          it('creates a dedicated acquire span for an explicit callback getConnection', async () => {
            const parent = tracer.startSpan('callback-acquire-parent')

            await Promise.all([
              agent.assertSomeTraces(traces => {
                const acquireSpan = traces[0].find(span => span.name === 'mariadb.pool.acquire')

                assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
                assert.strictEqual(acquireSpan.resource, 'mariadb.pool.acquire')
                assert.strictEqual(acquireSpan.parent_id.toString(), parent.context().toSpanId())
                assert.strictEqual(typeof acquireSpan.metrics['mariadb.pool.wait_time'], 'number')
              }, { spanResourceMatch: /^mariadb\.pool\.acquire$/ }),
              tracer.scope().activate(parent, () => new Promise((resolve, reject) => {
                pool.getConnection((error, connection) => {
                  if (error) {
                    reject(error)
                    return
                  }
                  connection.release()
                  parent.finish()
                  resolve()
                })
              })),
            ])
          })
        }
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
            mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb')

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

          if (semver.intersects(version, '>=3.4.1')) {
            for (const [method, sql] of [
              ['query', 'SELECT 5 AS promise_pool_wait'],
              ['execute', 'SELECT 6 AS execute_pool_wait'],
            ]) {
              it(`records the pool acquire wait time on the pooled ${method} span`, async () => {
                await Promise.all([
                  agent.assertSomeTraces(traces => {
                    const span = traces[0][0]

                    assert.strictEqual(typeof span.metrics['mariadb.pool.wait_time'], 'number')
                    assert.ok(span.metrics['mariadb.pool.wait_time'] >= 0)
                    assert.strictEqual(traces[0].find(span => span.name === 'mariadb.pool.acquire'), undefined)
                  }, { spanResourceMatch: new RegExp(`^${sql}$`) }),
                  pool[method](sql),
                ])
              })
            }

            it('uses zero wait without clock reads for a recent idle connection', async () => {
              const recentPool = mariadb.createPool({
                connectionLimit: 1,
                host: 'localhost',
                minDelayValidation: Number.MAX_SAFE_INTEGER,
                user: 'root',
              })

              try {
                await recentPool.query('SELECT 1')

                const tracePromise = agent.assertSomeTraces(traces => {
                  assert.strictEqual(traces[0][0].metrics['mariadb.pool.wait_time'], 0)
                }, { spanResourceMatch: /^SELECT 12 AS recent_idle_probe$/ })

                const queryPromise = withoutImmediateClockRead(() => {
                  return recentPool.query('SELECT 12 AS recent_idle_probe')
                })

                await Promise.all([tracePromise, queryPromise])
              } finally {
                await recentPool.end()
              }
            })

            it('includes idle-connection validation in the pool wait time', async () => {
              const validationPool = mariadb.createPool({
                connectionLimit: 1,
                host: 'localhost',
                minDelayValidation: 0,
                user: 'root',
              })

              try {
                await validationPool.query('SELECT 1')

                const tracePromise = agent.assertSomeTraces(traces => {
                  assert.strictEqual(traces[0][0].metrics['mariadb.pool.wait_time'], 50)
                }, { spanResourceMatch: /^SELECT 7 AS validation_probe$/ })

                await withFakeNow(100, async advanceTo => {
                  const queryPromise = validationPool.query('SELECT 7 AS validation_probe')
                  advanceTo(150)

                  await Promise.all([tracePromise, queryPromise])
                })
              } finally {
                await validationPool.end()
              }
            })

            it('does not classify sibling pool operations as query acquires', async () => {
              const batchPool = mariadb.createPool({
                connectionLimit: 1,
                database: 'db',
                host: 'localhost',
                minDelayValidation: 0,
                user: 'root',
              })

              try {
                await batchPool.query('CREATE TEMPORARY TABLE dd_batch_probe (value INT)')

                await withoutImmediateClockRead(() => {
                  return batchPool.batch('INSERT INTO dd_batch_probe VALUES (?)', [[1], [2]])
                })
              } finally {
                await batchPool.end()
              }
            })

            describe('when sibling pool operations are reentrant', () => {
              let batchPool

              beforeEach(async () => {
                batchPool = mariadb.createPool({
                  connectionLimit: 1,
                  database: 'db',
                  host: 'localhost',
                  minDelayValidation: Number.MAX_SAFE_INTEGER,
                  user: 'root',
                })
                await batchPool.query('CREATE TEMPORARY TABLE dd_reentrant_batch_probe (value INT)')
              })

              afterEach(async () => {
                await batchPool.end()
              })

              it('does not classify a sibling batch as an explicit acquire', async () => {
                const acquireStart = sinon.spy()
                const acquireFinish = sinon.spy()
                const acquireStartChannel = dc.channel('apm:mariadb:pool:acquire:start')
                const acquireFinishChannel = dc.channel('apm:mariadb:pool:acquire:finish')
                acquireStartChannel.subscribe(acquireStart)
                acquireFinishChannel.subscribe(acquireFinish)

                try {
                  let nestedBatch
                  batchPool.once('acquire', () => {
                    nestedBatch = batchPool.batch('INSERT INTO dd_reentrant_batch_probe VALUES (?)', [[1]])
                  })

                  const connection = await batchPool.getConnection()
                  await connection.release()
                  assert.ok(nestedBatch, 'nested batch did not start')
                  await nestedBatch

                  assert.strictEqual(acquireStart.callCount, 1)
                  assert.strictEqual(acquireFinish.callCount, 1)
                } finally {
                  acquireStartChannel.unsubscribe(acquireStart)
                  acquireFinishChannel.unsubscribe(acquireFinish)
                }
              })

              it('does not time a sibling batch as a pool query acquire', async () => {
                let nestedBatch
                batchPool.once('acquire', () => {
                  nestedBatch = withoutImmediateClockRead(() => {
                    return batchPool.batch('INSERT INTO dd_reentrant_batch_probe VALUES (?)', [[1]])
                  })
                })

                await batchPool.query('SELECT 15 AS reentrant_batch_probe')
                assert.ok(nestedBatch, 'nested batch did not start')
                await nestedBatch
              })
            })

            it('forwards pool operations without subscribers', async () => {
              tracer.use('mariadb', false)
              try {
                const rows = await pool.query('SELECT 11 AS untraced_pool_query')
                const connection = await pool.getConnection()

                await connection.release()
                assert.strictEqual(rows[0].untraced_pool_query, 11)
              } finally {
                tracer.use('mariadb', true)
              }
            })

            it('creates a dedicated acquire span for an explicit promise getConnection', async () => {
              const parent = tracer.startSpan('promise-acquire-parent')

              await Promise.all([
                agent.assertSomeTraces(traces => {
                  const acquireSpan = traces[0].find(span => span.name === 'mariadb.pool.acquire')
                  const querySpan = traces[0].find(span => span.resource === 'SELECT 8 AS acquired_probe')

                  assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
                  assert.strictEqual(acquireSpan.resource, 'mariadb.pool.acquire')
                  assert.strictEqual(acquireSpan.parent_id.toString(), parent.context().toSpanId())
                  assert.strictEqual(typeof acquireSpan.metrics['mariadb.pool.wait_time'], 'number')
                  assert.ok(querySpan, `missing query span: ${inspect(traces[0].map(span => span.resource))}`)
                  assert.strictEqual(querySpan.metrics['mariadb.pool.wait_time'], undefined)
                }, { spanResourceMatch: /^mariadb\.pool\.acquire$/ }),
                tracer.scope().activate(parent, async () => {
                  const connection = await pool.getConnection()
                  await connection.query('SELECT 8 AS acquired_probe')
                  await connection.release()
                  parent.finish()
                }),
              ])
            })

            it('does not classify a nested pool query as an explicit acquire', async () => {
              await pool.query('SELECT 1')

              const acquireStart = sinon.spy()
              const acquireFinish = sinon.spy()
              const acquireStartChannel = dc.channel('apm:mariadb:pool:acquire:start')
              const acquireFinishChannel = dc.channel('apm:mariadb:pool:acquire:finish')
              acquireStartChannel.subscribe(acquireStart)
              acquireFinishChannel.subscribe(acquireFinish)

              try {
                let nestedQuery
                pool.once('acquire', () => {
                  nestedQuery = pool.query('SELECT 13 AS nested_acquire_query')
                })

                const connection = await pool.getConnection()
                await connection.release()
                const rows = await nestedQuery

                assert.strictEqual(rows[0].nested_acquire_query, 13)
                assert.strictEqual(acquireStart.callCount, 1)
                assert.strictEqual(acquireFinish.callCount, 1)
              } finally {
                acquireStartChannel.unsubscribe(acquireStart)
                acquireFinishChannel.unsubscribe(acquireFinish)
              }
            })

            it('does not classify a nested explicit acquire as a pool query', async () => {
              const nestedPool = mariadb.createPool({
                connectionLimit: 1,
                host: 'localhost',
                minDelayValidation: Number.MAX_SAFE_INTEGER,
                user: 'root',
              })

              try {
                await nestedPool.query('SELECT 1')

                const parent = tracer.startSpan('nested-explicit-acquire-parent')

                await Promise.all([
                  agent.assertSomeTraces(traces => {
                    const acquireSpan = traces[0].find(span => span.name === 'mariadb.pool.acquire')
                    const querySpan = traces[0].find(span => span.resource === 'SELECT 14 AS nested_explicit_acquire')

                    assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
                    assert.ok(querySpan, `missing query span: ${inspect(traces[0].map(span => span.resource))}`)
                  }, { spanResourceMatch: /^nested-explicit-acquire-parent$/ }),
                  tracer.scope().activate(parent, async () => {
                    try {
                      let nestedAcquire
                      nestedPool.once('acquire', () => {
                        nestedAcquire = nestedPool.getConnection()
                      })

                      await nestedPool.query('SELECT 14 AS nested_explicit_acquire')
                      const connection = await nestedAcquire
                      await connection.release()
                    } finally {
                      parent.finish()
                    }
                  }),
                ])
              } finally {
                await nestedPool.end()
              }
            })

            it('records an error on explicit and pooled-query acquire failures', async () => {
              const failingPool = mariadb.createPool({
                acquireTimeout: 500,
                connectTimeout: 100,
                host: '127.0.0.1',
                port: await getClosedPort(),
                user: 'root',
              })
              failingPool.on('error', () => {})

              try {
                for (const [method, args] of [
                  ['getConnection', []],
                  ['query', ['SELECT 9 AS query_acquire_failure']],
                  ['execute', ['SELECT 10 AS execute_acquire_failure']],
                ]) {
                  await Promise.all([
                    agent.assertSomeTraces(traces => {
                      const acquireSpan = traces[0].find(span => span.name === 'mariadb.pool.acquire')

                      assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
                      assert.strictEqual(acquireSpan.error, 1)
                      assert.strictEqual(typeof acquireSpan.metrics['mariadb.pool.wait_time'], 'number')
                    }),
                    assert.rejects(failingPool[method](...args)),
                  ])
                }
              } finally {
                await failingPool.end()
              }
            })
          }
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
          mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb/callback')
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
            mariadb = proxyquire(`../../../versions/mariadb@${version}`, {}).get('mariadb')
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
        })
      }
    })
  })
})
