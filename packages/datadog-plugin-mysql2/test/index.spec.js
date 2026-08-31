'use strict'

const assert = require('node:assert/strict')
const net = require('node:net')
const { inspect } = require('node:util')

const { afterEach, before, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const ddpv = require('mocha/package.json').version
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { assertObjectContains } = require('../../../integration-tests/helpers')

const { expectedSchema, rawExpectedSchema } = require('./naming')

describe('Plugin', () => {
  let mysql2
  let tracer

  describe('mysql2', () => {
    withVersions('mysql2', 'mysql2', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      describe('without configuration', () => {
        let connection

        afterEach((done) => {
          connection.end(() => {
            agent.close().then(done)
          })
        })

        beforeEach(async () => {
          await agent.load('mysql2')
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          connection = mysql2.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })

          connection.connect()
        })

        withPeerService(
          () => tracer,
          'mysql2',
          (done) => connection.query('SELECT 1', (_) => done()),
          'db',
          'db.name'
        )

        withNamingSchema(
          () => new Promise((resolve) => {
            connection.query('SELECT 1', (_) => resolve())
          }),
          rawExpectedSchema.outbound
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

          query.on('result', () => {
            assert.strictEqual(tracer.scope().active(), null)
            done()
          })
        })

        it('should do automatic instrumentation', done => {
          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'SELECT 1 + 1 AS solution',
              type: 'sql',
              meta: {
                'span.kind': 'client',
                'db.name': 'db',
                'db.user': 'root',
                'db.type': 'mysql',
                component: 'mysql2',
              },
            }, { spanResourceMatch: /SELECT 1 \+ 1 AS solution/ })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution', (error, results, fields) => {
            if (error) throw error
          })
        })

        it('should support prepared statement shorthand', done => {
          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'SELECT ? + ? AS solution',
              type: 'sql',
              meta: {
                'span.kind': 'client',
                'db.name': 'db',
                'db.user': 'root',
                'db.type': 'mysql',
                component: 'mysql2',
              },
            }, { spanResourceMatch: /SELECT \? \+ \? AS solution/ })
            .then(done)
            .catch(done)

          connection.execute('SELECT ? + ? AS solution', [1, 1], (error, results, fields) => {
            if (error) throw error
          })

          connection.unprepare('SELECT ? + ? AS solution')
        })

        it('should support prepared statements', done => {
          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'SELECT ? + ? AS solution',
              type: 'sql',
              meta: {
                'span.kind': 'client',
                'db.name': 'db',
                'db.user': 'root',
                'db.type': 'mysql',
                component: 'mysql2',
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

        it('should handle errors', done => {
          let error

          agent
            .assertFirstTraceSpan((trace) => {
              assertObjectContains(trace, {
                meta: {
                  [ERROR_TYPE]: error.name,
                  [ERROR_MESSAGE]: error.message,
                  [ERROR_STACK]: error.stack,
                  component: 'mysql2',
                },
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
            .assertSomeTraces(() => {})
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution')
        })
      })

      describe('with configuration', () => {
        let connection

        afterEach((done) => {
          connection.end(() => {
            agent.close().then(done)
          })
        })

        beforeEach(async () => {
          await agent.load('mysql2', { service: 'custom' })
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          connection = mysql2.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })

          connection.connect()
        })

        withNamingSchema(
          () => new Promise((resolve) => {
            connection.query('SELECT 1', (_) => resolve())
          }),
          {
            v0: {
              opName: 'mysql.query',
              serviceName: 'custom',
            },
            v1: {
              opName: 'mysql.query',
              serviceName: 'custom',
            },
          }
        )

        it('should be configured with the correct values', done => {
          agent
            .assertFirstTraceSpan({
              service: 'custom',
            })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution')
        })
      })

      describe('with service configured as function', () => {
        const serviceSpy = sinon.stub().returns('custom')
        let connection

        afterEach((done) => {
          connection.end(() => {
            agent.close().then(done)
          })
        })

        beforeEach(async () => {
          await agent.load('mysql2', { service: serviceSpy })
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          connection = mysql2.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })

          connection.connect()
        })

        withNamingSchema(
          () => new Promise((resolve) => {
            connection.query('SELECT 1', (_) => resolve())
          }),
          {
            v0: {
              opName: 'mysql.query',
              serviceName: 'custom',
            },
            v1: {
              opName: 'mysql.query',
              serviceName: 'custom',
            },
          }
        )

        it('should be configured with the correct values', done => {
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].service, 'custom')
            sinon.assert.calledWith(serviceSpy, sinon.match({
              host: '127.0.0.1',
              user: 'root',
              database: 'db',
            }))
            done()
          })

          connection.query('SELECT 1 + 1 AS solution', () => {})
        })
      })

      describe('with a connection pool', () => {
        let pool

        before(() => agent.load('mysql2'))

        after(() => agent.close())

        afterEach((done) => {
          pool.end(() => done())
        })

        beforeEach(() => {
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          pool = mysql2.createPool({
            connectionLimit: 1,
            host: '127.0.0.1',
            user: 'root',
          })
        })

        withPeerService(
          () => tracer,
          'mysql2',
          (done) => pool.getConnection((error, connection) => {
            connection?.release()
            done(error)
          }),
          '127.0.0.1',
          'out.host',
          { desc: 'for explicit pool acquire', resource: 'mysql2.pool.acquire' }
        )

        it('should do automatic instrumentation', done => {
          agent
            .assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'SELECT 1 + 1 AS solution',
              type: 'sql',
              meta: {
                'span.kind': 'client',
                'db.user': 'root',
                'db.type': 'mysql',
                component: 'mysql2',
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

        for (const [method, sql] of [
          ['query', 'SELECT 4 AS pool_wait_probe'],
          ['execute', 'SELECT 14 AS execute_pool_wait'],
        ]) {
          it(`records the pool acquire wait time on the pooled ${method} span`, async () => {
            await Promise.all([
              agent.assertSomeTraces(traces => {
                const span = traces[0][0]

                assert.strictEqual(typeof span.metrics['mysql2.pool.wait_time'], 'number')
                assert.ok(span.metrics['mysql2.pool.wait_time'] >= 0)
                assert.strictEqual(traces[0].find(span => span.name === 'mysql2.pool.acquire'), undefined)
              }, { spanResourceMatch: new RegExp(`^${sql}$`) }),
              new Promise((resolve, reject) => {
                pool[method](sql, error => error ? reject(error) : resolve())
              }),
            ])
          })
        }

        it('carries the pool wait when query dispatch is deferred after acquisition', async () => {
          const getConnection = pool.getConnection
          pool.getConnection = function (callback) {
            return getConnection.call(this, function () {
              setImmediate(() => callback.apply(this, arguments))
            })
          }

          try {
            await Promise.all([
              agent.assertSomeTraces(traces => {
                const span = traces[0][0]

                assert.strictEqual(typeof span.metrics['mysql2.pool.wait_time'], 'number')
                assert.strictEqual(traces[0].find(span => span.name === 'mysql2.pool.acquire'), undefined)
              }, { spanResourceMatch: /^SELECT 13 AS deferred_dispatch$/ }),
              new Promise((resolve, reject) => {
                pool.query('SELECT 13 AS deferred_dispatch', error => error ? reject(error) : resolve())
              }),
            ])
          } finally {
            pool.getConnection = getConnection
          }
        })

        it('reports a zero wait time when an idle pooled connection is reused', async () => {
          await new Promise((resolve, reject) => {
            pool.query('SELECT 1', error => error ? reject(error) : resolve())
          })
          // Let the first query's `end` handler return the connection to the free list before reusing it.
          await new Promise(resolve => setImmediate(resolve))

          await Promise.all([
            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].metrics['mysql2.pool.wait_time'], 0)
            }, { spanResourceMatch: /^SELECT 7 AS idle_probe$/ }),
            new Promise((resolve, reject) => {
              pool.query('SELECT 7 AS idle_probe', error => error ? reject(error) : resolve())
            }),
          ])
        })

        it('creates a dedicated acquire span for an explicit callback pool.getConnection()', done => {
          const parent = tracer.startSpan('acquire-callback-parent')

          agent.assertSomeTraces(traces => {
            const acquireSpan = traces[0].find(span => span.name === 'mysql2.pool.acquire')

            assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
            assert.strictEqual(acquireSpan.resource, 'mysql2.pool.acquire')
            assert.strictEqual(acquireSpan.parent_id.toString(), parent.context().toSpanId())
            assert.strictEqual(typeof acquireSpan.metrics['mysql2.pool.wait_time'], 'number')
            assert.ok(acquireSpan.metrics['mysql2.pool.wait_time'] >= 0)
          }, { spanResourceMatch: /^mysql2\.pool\.acquire$/ })
            .then(done)
            .catch(done)

          tracer.scope().activate(parent, () => {
            pool.getConnection((error, connection) => {
              if (error) return done(error)
              connection.release()
              parent.finish()
            })
          })
        })

        it('creates a dedicated acquire span for an explicit promise pool.getConnection()', async function () {
          // `pool.promise()` was added in mysql2 2.x; older versions ship a standalone promise module.
          if (typeof pool.promise !== 'function') {
            return this.skip()
          }

          const parent = tracer.startSpan('acquire-promise-parent')

          const tracePromise = agent.assertSomeTraces(traces => {
            const acquireSpan = traces[0].find(span => span.name === 'mysql2.pool.acquire')

            assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
            assert.strictEqual(acquireSpan.parent_id.toString(), parent.context().toSpanId())
            assert.strictEqual(typeof acquireSpan.metrics['mysql2.pool.wait_time'], 'number')
          }, { spanResourceMatch: /^mysql2\.pool\.acquire$/ })

          await tracer.scope().activate(parent, async () => {
            const connection = await pool.promise().getConnection()
            connection.release()
            parent.finish()
          })

          await tracePromise
        })

        it('records an error on explicit and pooled-query acquire failures', async () => {
          const failingPool = mysql2.createPool({
            host: '127.0.0.1',
            port: await getClosedPort(),
            user: 'root',
            connectTimeout: 500,
          })
          failingPool.on('error', () => {})

          try {
            for (const acquire of [
              callback => failingPool.getConnection(callback),
              callback => failingPool.query('SELECT 15 AS acquire_failure', callback),
              callback => failingPool.execute('SELECT 16 AS execute_acquire_failure', [], callback),
            ]) {
              await Promise.all([
                agent.assertSomeTraces(traces => {
                  const acquireSpan = traces[0].find(span => span.name === 'mysql2.pool.acquire')

                  assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
                  assert.strictEqual(acquireSpan.error, 1)
                }),
                new Promise((resolve, reject) => {
                  acquire(error => error ? resolve() : reject(new Error('expected acquire error')))
                }),
              ])
            }
          } finally {
            await new Promise(resolve => failingPool.end(resolve))
          }
        })

        it('does not create an acquire span for a pool cluster query', function (done) {
          const cluster = mysql2.createPoolCluster()
          cluster.add('test-node', { host: '127.0.0.1', user: 'root', connectionLimit: 1 })
          const namespace = cluster.of('*')

          // PoolNamespace#query does not exist before mysql2 2.3.0.
          if (typeof namespace.query !== 'function') {
            cluster.end(() => {})
            return this.skip()
          }

          agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.strictEqual(traces[0].find(span => span.name === 'mysql2.pool.acquire'), undefined)
            assert.strictEqual(typeof span.metrics['mysql2.pool.wait_time'], 'number')
            assert.ok(span.metrics['mysql2.pool.wait_time'] >= 0)
          }, { spanResourceMatch: /^SELECT 8 AS cluster_probe$/ })
            .then(() => cluster.end(() => done()))
            .catch(error => cluster.end(() => done(error)))

          namespace.query('SELECT 8 AS cluster_probe', error => {
            if (error) cluster.end(() => done(error))
          })
        })

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
         * @param {import('mysql2').PoolNamespace} namespace
         */
        function deferFirstRetry (namespace) {
          const getConnection = namespace.getConnection
          let getConnectionCalls = 0
          namespace.getConnection = function () {
            if (++getConnectionCalls === 2) {
              setImmediate(() => getConnection.apply(this, arguments))
              return
            }
            return getConnection.apply(this, arguments)
          }
        }

        it('retains pooled-query classification across a tick-delayed canRetry failover', async function () {
          const supportProbe = mysql2.createPoolCluster()
          const supported = typeof supportProbe.of('*').query === 'function'
          supportProbe.end(() => {})
          if (!supported) return this.skip()

          const cluster = mysql2.createPoolCluster()
          cluster.add('dead', {
            host: '127.0.0.1',
            user: 'root',
            port: await getClosedPort(),
            connectionLimit: 1,
          })
          cluster.add('live', { host: '127.0.0.1', user: 'root', database: 'db', connectionLimit: 1 })
          cluster.on('warn', () => {})
          const namespace = cluster.of('*')
          deferFirstRetry(namespace)

          try {
            await Promise.all([
              agent.assertSomeTraces(traces => {
                const span = traces[0][0]

                assert.strictEqual(typeof span.metrics['mysql2.pool.wait_time'], 'number')
                assert.strictEqual(traces[0].find(span => span.name === 'mysql2.pool.acquire'), undefined)
              }, { spanResourceMatch: /^SELECT 9 AS failover_probe$/ }),
              new Promise((resolve, reject) => {
                namespace.query('SELECT 9 AS failover_probe', error => error ? reject(error) : resolve())
              }),
            ])
          } finally {
            await new Promise(resolve => cluster.end(resolve))
          }
        })

        it('creates a dedicated acquire span for an explicit namespace.getConnection()', function (done) {
          const cluster = mysql2.createPoolCluster()
          cluster.add('test-node', { host: '127.0.0.1', user: 'root', connectionLimit: 1 })
          const namespace = cluster.of('*')

          // The pool-cluster namespace instrumentation arrived together with PoolNamespace#query.
          if (typeof namespace.query !== 'function' || typeof namespace.getConnection !== 'function') {
            cluster.end(() => {})
            return this.skip()
          }

          const parent = tracer.startSpan('namespace-acquire-parent')

          agent.assertSomeTraces(traces => {
            const acquireSpan = traces[0].find(span => span.name === 'mysql2.pool.acquire')

            assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
            assert.strictEqual(acquireSpan.parent_id.toString(), parent.context().toSpanId())
            // The wait belongs on the acquire span here, not folded into a later query span.
            assert.strictEqual(typeof acquireSpan.metrics['mysql2.pool.wait_time'], 'number')
            assert.ok(acquireSpan.metrics['mysql2.pool.wait_time'] >= 0)
          }, { spanResourceMatch: /^mysql2\.pool\.acquire$/ })
            .then(() => cluster.end(() => done()))
            .catch(error => cluster.end(() => done(error)))

          tracer.scope().activate(parent, () => {
            namespace.getConnection((error, connection) => {
              if (error) return cluster.end(() => done(error))
              connection.release()
              parent.finish()
            })
          })
        })

        it('records the acquire error when every pool-cluster node fails', async function () {
          const cluster = mysql2.createPoolCluster({ removeNodeErrorCount: 1 })
          cluster.add('dead', {
            host: '127.0.0.1',
            user: 'root',
            port: await getClosedPort(),
            connectionLimit: 1,
          })
          cluster.on('warn', () => {})
          const namespace = cluster.of('*')

          if (typeof namespace.query !== 'function') {
            cluster.end(() => {})
            return this.skip()
          }

          try {
            await Promise.all([
              agent.assertSomeTraces(traces => {
                const acquireSpan = traces[0].find(span => span.name === 'mysql2.pool.acquire')

                assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
                assert.strictEqual(acquireSpan.error, 1)
                assert.strictEqual(typeof acquireSpan.metrics['mysql2.pool.wait_time'], 'number')
              }),
              new Promise((resolve, reject) => {
                namespace.query('SELECT 12 AS all_nodes_down', error => {
                  return error ? resolve() : reject(new Error('expected acquire error'))
                })
              }),
            ])
          } finally {
            await new Promise(resolve => cluster.end(resolve))
          }
        })
      })
      describe('with DBM propagation enabled with service using plugin configurations', () => {
        let connection

        before(async () => {
          await agent.load('mysql2', { dbmPropagationMode: 'service', service: 'serviced' })
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          connection = mysql2.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        it('should contain comment in query text', done => {
          const connect = connection.query('SELECT 1 + 1 AS solution', (...args) => {
            try {
              assert.strictEqual(connect.sql, '/*dddb=\'db\',dddbs=\'serviced\',dde=\'tester\',ddh=\'127.0.0.1\',' +
              `ddps='test',ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
            } catch (e) {
              done(e)
            }
            done()
          })
        })

        it('trace query resource should not be changed when propagation is enabled', done => {
          agent
            .assertFirstTraceSpan({
              resource: 'SELECT 1 + 1 AS solution',
            })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution', (err) => {
            if (err) return done(err)
            connection.end((err) => {
              if (err) return done(err)
            })
          })
        })
      })
      describe('DBM propagation should handle special characters', () => {
        let connection

        afterEach((done) => {
          connection.end(() => {
            agent.close().then(done)
          })
        })

        beforeEach(async () => {
          await agent.load('mysql2', { dbmPropagationMode: 'service', service: '~!@#$%^&*()_+|??/<>' })
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          connection = mysql2.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        it('DBM propagation should handle special characters', done => {
          const connect = connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(connect.sql,
                '/*dddb=\'db\',dddbs=\'~!%40%23%24%25%5E%26*()_%2B%7C%3F%3F%2F%3C%3E\',dde=\'tester\',' +
                `ddh='127.0.0.1',ddps='test',ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
              done()
            } catch (e) {
              done(e)
            }
          })
        })
      })
      describe('with DBM propagation enabled with full using tracer configurations', () => {
        let connection

        afterEach((done) => {
          connection.end(() => {
            agent.close().then(done)
          })

          global._ddtrace._tracer.configure({ env: 'tester', sampler: { sampleRate: 1 } })
        })

        beforeEach(async () => {
          await agent.load('mysql2', { dbmPropagationMode: 'full', service: 'post' })
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          connection = mysql2.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        it('query text should contain traceparent', done => {
          let queryText = ''
          agent.assertSomeTraces(traces => {
            const expectedTimePrefix = traces[0][0].meta['_dd.p.tid'].toString(16).padStart(16, '0')
            const traceId = expectedTimePrefix + traces[0][0].trace_id.toString(16).padStart(16, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')

            assert.strictEqual(queryText,
              `/*dddb='db',dddbs='post',dde='tester',ddh='127.0.0.1',ddps='test',ddpv='${ddpv}',` +
            `traceparent='00-${traceId}-${spanId}-01'*/ SELECT 1 + 1 AS solution`)
          }).then(done, done)
          const connect = connection.query('SELECT 1 + 1 AS solution', () => {
            queryText = connect.sql
          })
        })

        it('query text should contain rejected sampling decision in the traceparent', done => {
          global._ddtrace._tracer.configure({ env: 'tester', sampler: { sampleRate: 0 } })
          let queryText = ''

          agent.assertSomeTraces(traces => {
            const expectedTimePrefix = traces[0][0].meta['_dd.p.tid'].toString(16).padStart(16, '0')
            const traceId = expectedTimePrefix + traces[0][0].trace_id.toString(16).padStart(16, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')

            assert.match(
              queryText,
              new RegExp(`traceparent='00\\-${traceId}\\-${spanId}\\-00'\\*\\/ SELECT 1 \\+ 1 AS solution`)
            )
          }).then(done, done)

          const connect = connection.query('SELECT 1 + 1 AS solution', () => {
            queryText = connect.sql
          })
        })

        it('query should inject _dd.dbm_trace_injected into span', done => {
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].meta['_dd.dbm_trace_injected'], 'true')
            done()
          })
          connection.query('SELECT 1 + 1 AS solution', () => {
          })
        })
      })
      describe('with DBM propagation enabled with service using a connection pool', () => {
        let pool

        afterEach((done) => {
          pool.end(() => {
            agent.close().then(done)
          })
        })

        beforeEach(async () => {
          await agent.load('mysql2', { dbmPropagationMode: 'service', service: 'post' })
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          pool = mysql2.createPool({
            connectionLimit: 1,
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })
        })

        it('should contain comment in query text', done => {
          const queryPool = pool.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(queryPool.sql,
                '/*dddb=\'db\',dddbs=\'post\',dde=\'tester\',ddh=\'127.0.0.1\',' +
                `ddps='test',ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
            } catch (e) {
              done(e)
            }
            done()
          })
        })
      })
      describe('with DBM propagation enabled with service using a connection pool', () => {
        let pool

        afterEach((done) => {
          pool.end(() => {
            agent.close().then(done)
          })

          global._ddtrace._tracer.configure({ env: 'tester', sampler: { sampleRate: 1 } })
        })

        beforeEach(async () => {
          await agent.load('mysql2', { dbmPropagationMode: 'full', service: 'post' })
          mysql2 = proxyquire(`../../../versions/mysql2@${version}`, {}).get()

          pool = mysql2.createPool({
            connectionLimit: 1,
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })
        })

        it('query text should contain traceparent', done => {
          let queryText = ''
          agent.assertSomeTraces(traces => {
            const expectedTimePrefix = traces[0][0].meta['_dd.p.tid'].toString(16).padStart(16, '0')
            const traceId = expectedTimePrefix + traces[0][0].trace_id.toString(16).padStart(16, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')

            assert.strictEqual(queryText,
              `/*dddb='db',dddbs='post',dde='tester',ddh='127.0.0.1',ddps='test',ddpv='${ddpv}',` +
            `traceparent='00-${traceId}-${spanId}-01'*/ SELECT 1 + 1 AS solution`)
          }).then(done, done)
          const queryPool = pool.query('SELECT 1 + 1 AS solution', () => {
            queryText = queryPool.sql
          })
        })

        it('query text should contain rejected sampling decision in the traceparent', done => {
          global._ddtrace._tracer.configure({ env: 'tester', sampler: { sampleRate: 0 } })
          let queryText = ''

          agent.assertSomeTraces(traces => {
            const expectedTimePrefix = traces[0][0].meta['_dd.p.tid'].toString(16).padStart(16, '0')
            const traceId = expectedTimePrefix + traces[0][0].trace_id.toString(16).padStart(16, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')

            assert.match(
              queryText,
              new RegExp(`traceparent='00\\-${traceId}\\-${spanId}\\-00'\\*\\/ SELECT 1 \\+ 1 AS solution`)
            )
          }).then(done, done)

          const queryPool = pool.query('SELECT 1 + 1 AS solution', () => {
            queryText = queryPool.sql
          })
        })

        it('query should inject _dd.dbm_trace_injected into span', done => {
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].meta['_dd.dbm_trace_injected'], 'true')
            done()
          })
          pool.query('SELECT 1 + 1 AS solution', () => {
          })
        })
      })
    })
  })
})
