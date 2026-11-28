'use strict'

const assert = require('node:assert/strict')
const dc = require('node:diagnostics_channel')
// eslint-disable-next-line n/no-deprecated-api -- mysql binds queued callbacks to the active domain.
const { create: createDomain } = require('node:domain')
const net = require('node:net')
const { inspect, promisify } = require('node:util')

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
  let mysql
  let tracer

  describe('mysql', () => {
    withVersions('mysql', 'mysql', version => {
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
          await agent.load('mysql')
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()
          connection = mysql.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        withNamingSchema(
          () => connection.query('SELECT 1 + 1 AS solution', () => {}),
          rawExpectedSchema.outbound
        )

        it('should propagate context to callbacks, with correct callback args', done => {
          const span = tracer.startSpan('test')

          tracer.scope().activate(span, () => {
            const span = tracer.scope().active()
            connection.query('SELECT 1 + 1 AS solution', (err, results, fields) => {
              assert.notStrictEqual(results, null)
              assert.notStrictEqual(fields, null)
              assert.strictEqual(tracer.scope().active(), span)
              done()
            })
          })
        })

        it('should preserve successful query callback semantics', async () => {
          let query

          await new Promise((resolve, reject) => {
            /**
             * @param {Error | null} error
             * @param {object[] | undefined} results
             * @param {object[] | undefined} fields
             */
            function callback (error, results, fields) {
              try {
                assert.strictEqual(arguments.length, 3)
                assert.strictEqual(this, query)
                assert.strictEqual(error, null)
                assert.ok(Array.isArray(results))
                assert.ok(Array.isArray(fields))
                resolve()
              } catch (error) {
                reject(error)
              }
            }

            query = connection.query('SELECT 1 + 1 AS solution', callback)
          })
        })

        it('should preserve failed query callback semantics', async () => {
          const probe = net.createServer()
          await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
          const { port } = probe.address()
          await new Promise(resolve => probe.close(resolve))

          const failedConnection = mysql.createConnection({
            host: '127.0.0.1',
            port,
            user: 'root',
            connectTimeout: 500,
          })
          let query

          await new Promise((resolve, reject) => {
            /**
             * @param {Error} error
             */
            function callback (error) {
              failedConnection.destroy()
              try {
                assert.strictEqual(arguments.length, 1)
                assert.strictEqual(this, query)
                assert.ok(error instanceof Error)
                resolve()
              } catch (error) {
                reject(error)
              }
            }

            query = failedConnection.query('SELECT 1', callback)
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
                component: 'mysql',
                '_dd.integration': 'mysql',
              },
              metrics: {
                'network.destination.port': 3306,
              },
            }, { spanResourceMatch: /SELECT 1 \+ 1 AS solution/ })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution', (error, results, fields) => {
            if (error) throw error
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
                  component: 'mysql',
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
          agent.assertSomeTraces(traces => {
            done()
          })

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
          await agent.load('mysql', { service: 'custom' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        withNamingSchema(
          () => connection.query('SELECT 1 + 1 AS solution', () => {}),
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
              name: expectedSchema.outbound.opName,
              service: 'custom',
            })
            .then(done)
            .catch(done)

          connection.query('SELECT 1 + 1 AS solution', () => {})
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
          await agent.load('mysql', { service: serviceSpy })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        withNamingSchema(
          () => connection.query('SELECT 1 + 1 AS solution', () => {}),
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
            assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
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

      describe('with a connection pool', () => {
        let pool

        before(() => agent.load('mysql'))

        after(() => agent.close())

        afterEach((done) => {
          pool.end(() => done())
        })

        beforeEach(() => {
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          pool = mysql.createPool({
            connectionLimit: 1,
            host: 'localhost',
            user: 'root',
            database: 'db',
          })
        })

        withPeerService(
          () => tracer,
          'mysql',
          (done) => pool.query('SELECT 1', (_) => done()),
          'db',
          'db.name'
        )

        withPeerService(
          () => tracer,
          'mysql',
          (done) => pool.getConnection((error, connection) => {
            connection?.release()
            done(error)
          }),
          'db',
          'db.name',
          { desc: 'for explicit pool acquire', resource: 'mysql.pool.acquire' }
        )

        it('skips wait timing for an explicit checkout and a queued query when poolAcquire is false', async () => {
          tracer.use('mysql', { poolAcquire: false })
          const borrow = promisify(pool.getConnection).bind(pool)
          const parent = tracer.startSpan('caller')
          const scope = tracer.scope()
          const finishChannel = dc.channel('dd-trace:span:finish')
          let acquireSpans = 0
          let queryTags
          const onSpanFinish = span => {
            const context = span.context()
            if (context._name === 'mysql.pool.acquire') acquireSpans++
            const tags = context.getTags()
            if (tags['resource.name'] === 'SELECT 42 AS disabled_pool_wait') queryTags = tags
          }
          finishChannel.subscribe(onSpanFinish)

          try {
            const holder = await borrow()
            let query
            let clockReads
            const clock = sinon.spy(performance, 'now')
            try {
              query = scope.activate(parent, () => new Promise((resolve, reject) => {
                pool.query('SELECT 42 AS disabled_pool_wait', (error, rows) => {
                  if (error) reject(error)
                  else resolve({ rows, activeSpan: scope.active() })
                })
              }))
              clockReads = clock.callCount
            } finally {
              clock.restore()
              holder.release()
            }

            const { rows, activeSpan } = await query
            assert.strictEqual(acquireSpans, 0)
            assert.strictEqual(clockReads, 0)
            assert.ok(queryTags)
            assert.strictEqual(queryTags['mysql.pool.wait_time'], undefined)
            assert.strictEqual(activeSpan, parent)
            assert.strictEqual(rows[0].disabled_pool_wait, 42)
          } finally {
            parent.finish()
            finishChannel.unsubscribe(onSpanFinish)
            tracer.use('mysql', {})
          }
        })

        it('keeps a domain-bound checkout admitted with poolAcquire false out of tracing', async function () {
          if (typeof pool._enqueueCallback !== 'function') return this.skip()

          const borrow = promisify(pool.getConnection).bind(pool)
          const scope = tracer.scope()
          const parent = tracer.startSpan('caller')
          const domain = createDomain()
          const finishChannel = dc.channel('dd-trace:span:finish')
          const acquireSpans = []
          let callbackCalls = 0
          const onSpanFinish = span => {
            if (span.context()._name === 'mysql.pool.acquire') acquireSpans.push(span)
          }

          finishChannel.subscribe(onSpanFinish)
          try {
            for (let checkout = 0; checkout < 2; checkout++) {
              tracer.use('mysql', { poolAcquire: false })
              const holder = await borrow()
              pool.once('enqueue', () => {
                tracer.use('mysql', { poolAcquire: true })
                holder.destroy()
              })
              const { connection, activeSpan, activeDomain } = await scope.activate(parent, () => domain.run(() => {
                return new Promise((resolve, reject) => {
                  pool.getConnection((error, connection) => {
                    callbackCalls++
                    if (error) reject(error)
                    else resolve({ connection, activeSpan: scope.active(), activeDomain: process.domain })
                  })
                })
              }))
              connection.release()
              assert.strictEqual(activeSpan, parent)
              assert.strictEqual(activeDomain, domain)
            }
            assert.strictEqual(acquireSpans.length, 0)
            assert.strictEqual(callbackCalls, 2)
          } finally {
            parent.finish()
            finishChannel.unsubscribe(onSpanFinish)
            tracer.use('mysql', {})
          }
        })

        it('traces a fresh checkout when it reuses a callback queued while mysql was disabled', async function () {
          if (typeof pool._enqueueCallback !== 'function') return this.skip()

          const borrow = promisify(pool.getConnection).bind(pool)
          const first = await borrow()
          const domainCheckout = createDomain().run(borrow)
          first.release()
          const observed = await domainCheckout
          observed.release()

          let complete
          const reused = (...args) => complete(...args)
          const checkout = () => new Promise((resolve, reject) => {
            complete = (error, connection) => error ? reject(error) : resolve(connection)
            pool.getConnection(reused)
          })
          const spanFinish = dc.channel('dd-trace:span:finish')
          let acquireCount = 0
          const countAcquire = span => {
            if (span.context()._name === 'mysql.pool.acquire') acquireCount++
          }

          try {
            const holder = await borrow()
            tracer.use('mysql', false)
            const queued = checkout()
            tracer.use('mysql', {})
            holder.release()
            const acquired = await queued
            acquired.release()

            spanFinish.subscribe(countAcquire)
            const fresh = await checkout()
            fresh.release()
            assert.strictEqual(acquireCount, 1)
          } finally {
            spanFinish.unsubscribe(countAcquire)
            tracer.use('mysql', {})
          }
        })

        it('keeps tracing when an acquire finishes without a matching start', async () => {
          dc.channel('apm:mysql:pool:acquire:finish').publish({ poolWaitTime: 1 })

          await Promise.all([
            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta['db.type'], 'mysql')
            }, { spanResourceMatch: /^SELECT 15 AS survivor$/ }),
            new Promise((resolve, reject) => {
              pool.query('SELECT 15 AS survivor', error => error ? reject(error) : resolve())
            }),
          ])
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
                'db.user': 'root',
                'db.type': 'mysql',
                component: 'mysql',
              },
            })
            .then(done)
            .catch(done)

          pool.query('SELECT 1 + 1 AS solution', () => {})
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

        it('records the pool acquire wait time on the pooled query span', done => {
          agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            assert.strictEqual(typeof span.metrics['mysql.pool.wait_time'], 'number')
            assert.ok(span.metrics['mysql.pool.wait_time'] >= 0)
            assert.strictEqual(traces[0].find(span => span.name === 'mysql.pool.acquire'), undefined)
          }, { spanResourceMatch: /^SELECT 4 AS pool_wait_probe$/ })
            .then(done)
            .catch(done)

          pool.query('SELECT 4 AS pool_wait_probe', error => {
            if (error) done(error)
          })
        })

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

                assert.strictEqual(typeof span.metrics['mysql.pool.wait_time'], 'number')
                assert.strictEqual(traces[0].find(span => span.name === 'mysql.pool.acquire'), undefined)
              }, { spanResourceMatch: /^SELECT 13 AS deferred_dispatch$/ }),
              new Promise((resolve, reject) => {
                pool.query('SELECT 13 AS deferred_dispatch', error => error ? reject(error) : resolve())
              }),
            ])
          } finally {
            pool.getConnection = getConnection
          }
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

        for (const [deferredRetry, poolAcquire] of [[false, true], [true, true], [false, false]]) {
          const scheduling = deferredRetry ? 'tick-delayed' : 'synchronous'
          const admission = poolAcquire ? '' : ' admitted with poolAcquire false'
          const title = `retains pooled-query classification across a ${scheduling} canRetry failover`

          it(`${title}${admission}`, async function () {
            const unsupportedCluster = mysql.createPoolCluster()
            const supported = typeof unsupportedCluster.of('*').query === 'function'
            unsupportedCluster.end(() => {})
            if (!supported) return this.skip()

            const cluster = mysql.createPoolCluster(poolAcquire ? {} : { removeNodeErrorCount: 1 })
            cluster.add('dead', {
              host: '127.0.0.1',
              user: 'root',
              port: await getClosedPort(),
              connectionLimit: 1,
            })
            cluster.add('live', { host: '127.0.0.1', user: 'root', database: 'db', connectionLimit: 1 })
            cluster.on('warn', () => {})
            const namespace = cluster.of('*')
            const finishChannel = dc.channel('dd-trace:span:finish')
            let acquireSpans = 0
            const onSpanFinish = span => {
              if (span.context()._name === 'mysql.pool.acquire') acquireSpans++
            }
            if (!poolAcquire) {
              tracer.use('mysql', { poolAcquire: false })
              finishChannel.subscribe(onSpanFinish)
              cluster.once('remove', node => {
                assert.strictEqual(node, 'dead')
                tracer.use('mysql', { poolAcquire: true })
              })
            }
            if (deferredRetry) {
              const query = namespace.query
              let queryCalls = 0
              namespace.query = function () {
                if (++queryCalls === 2) {
                  setImmediate(() => query.apply(this, arguments))
                  return arguments[0]
                }
                return query.apply(this, arguments)
              }
            }
            const resource = `SELECT 9 AS ${scheduling.replace('-', '_')}_failover_probe`

            try {
              await Promise.all([
                agent.assertSomeTraces(traces => {
                  const span = traces[0][0]

                  if (poolAcquire) {
                    assert.strictEqual(typeof span.metrics['mysql.pool.wait_time'], 'number')
                  } else {
                    assert.strictEqual(span.metrics['mysql.pool.wait_time'], undefined)
                  }
                  assert.strictEqual(traces[0].find(span => span.name === 'mysql.pool.acquire'), undefined)
                }, { spanResourceMatch: new RegExp(`^${resource}$`) }),
                new Promise((resolve, reject) => {
                  namespace.query(resource, error => error ? reject(error) : resolve())
                }),
              ])
              if (!poolAcquire) assert.strictEqual(acquireSpans, 0)
            } finally {
              if (!poolAcquire) {
                finishChannel.unsubscribe(onSpanFinish)
                tracer.use('mysql', {})
              }
              await new Promise(resolve => cluster.end(resolve))
            }
          })
        }

        it('records a final acquire error when every pool-cluster node fails', async function () {
          const cluster = mysql.createPoolCluster({ removeNodeErrorCount: 1 })
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
                const acquireSpan = traces[0].find(span => span.name === 'mysql.pool.acquire')

                assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
                assert.strictEqual(acquireSpan.error, 1)
                assert.strictEqual(typeof acquireSpan.metrics['mysql.pool.wait_time'], 'number')
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

        it('reports a zero wait time when an idle pooled connection is reused', async () => {
          await new Promise((resolve, reject) => {
            pool.query('SELECT 1', error => error ? reject(error) : resolve())
          })
          // Let the first query's release return the connection to the free list before reusing it.
          await new Promise(resolve => setImmediate(resolve))

          await Promise.all([
            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].metrics['mysql.pool.wait_time'], 0)
            }, { spanResourceMatch: /^SELECT 7 AS idle_probe$/ }),
            new Promise((resolve, reject) => {
              pool.query('SELECT 7 AS idle_probe', error => error ? reject(error) : resolve())
            }),
          ])
        })

        it('creates a dedicated acquire span for an explicit pool.getConnection()', done => {
          const parent = tracer.startSpan('acquire-parent')

          agent.assertSomeTraces(traces => {
            const acquireSpan = traces[0].find(span => span.name === 'mysql.pool.acquire')

            assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
            assert.strictEqual(acquireSpan.resource, 'mysql.pool.acquire')
            assert.strictEqual(acquireSpan.parent_id.toString(), parent.context().toSpanId())
            assert.strictEqual(typeof acquireSpan.metrics['mysql.pool.wait_time'], 'number')
            assert.ok(acquireSpan.metrics['mysql.pool.wait_time'] >= 0)
          }, { spanResourceMatch: /^mysql\.pool\.acquire$/ })
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

        it('records an error on explicit and pooled-query acquire failures', async () => {
          const failingPool = mysql.createPool({
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
            ]) {
              await Promise.all([
                agent.assertSomeTraces(traces => {
                  const acquireSpan = traces[0].find(span => span.name === 'mysql.pool.acquire')

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
      })

      describe('comment injection interaction with peer service', () => {
        let connection
        let computeStub
        let remapStub

        before(async () => {
          await agent.load('mysql', { dbmPropagationMode: 'service', service: 'serviced' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        beforeEach(() => {
          const plugin = tracer._pluginManager._pluginsByName.mysql
          computeStub = sinon.stub(plugin._tracerConfig, 'spanComputePeerService')
          remapStub = sinon.stub(plugin._tracerConfig, 'peerServiceMapping')
        })

        afterEach(() => {
          computeStub.restore()
          remapStub.restore()
        })

        it('should omit ddprs when peer service computation is disabled', done => {
          computeStub.value(false)
          remapStub.value({})
          connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(connection._protocol._queue[0].sql,
                '/*dddb=\'db\',dddbs=\'serviced\',dde=\'tester\',ddh=\'127.0.0.1\',ddps=\'test\'' +
                `,ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
            } catch (e) {
              done(e)
            }
            done()
          })
        })

        it('should keep dddbs as the service name when the peer service is computed from db.name', done => {
          computeStub.value(true)
          remapStub.value({})
          connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(connection._protocol._queue[0].sql,
                '/*dddb=\'db\',dddbs=\'serviced\',dde=\'tester\',ddh=\'127.0.0.1\',ddps=\'test\'' +
                `,ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
            } catch (e) {
              done(e)
            }
            done()
          })
        })

        it('should ignore a peer service mapping when the peer service is computed from db.name', done => {
          computeStub.value(true)
          remapStub.value({ db: 'remappedDB' })
          connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(connection._protocol._queue[0].sql,
                '/*dddb=\'db\',dddbs=\'serviced\',dde=\'tester\',ddh=\'127.0.0.1\',' +
                `ddps='test',ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
            } catch (e) {
              done(e)
            }
            done()
          })
        })
      })

      describe('with DBM propagation enabled with service using plugin configurations', () => {
        let connection

        before(async () => {
          await agent.load('mysql', { dbmPropagationMode: 'service', service: 'serviced' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        it('should contain comment in query text', done => {
          connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(connection._protocol._queue[0].sql,
                '/*dddb=\'db\',dddbs=\'serviced\',dde=\'tester\',ddh=\'127.0.0.1\',ddps=\'test\',' +
                `ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
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

      describe('with DBM propagation enabled with service using tracer configurations', () => {
        let connection

        before(async () => {
          // Tracer-level config (third arg) only takes effect if the global
          // tracer is wiped first; tracer.init() short-circuits once the
          // process-wide singleton has been initialized by an earlier load.
          await agent.load('mysql', { service: 'serviced' }, { dbmPropagationMode: 'service' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        after((done) => {
          connection.end(() => {
            agent.close().then(done)
          })
        })

        it('should contain service mode comment in query text', done => {
          connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(connection._protocol._queue[0].sql,
                '/*dddb=\'db\',dddbs=\'serviced\',dde=\'tester\',ddh=\'127.0.0.1\',ddps=\'test\',' +
                `ddpv='${ddpv}'*/ SELECT 1 + 1 AS solution`)
            } catch (e) {
              done(e)
            }
            done()
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
          await agent.load('mysql', { dbmPropagationMode: 'service', service: '~!@#$%^&*()_+|??/<>' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })
          connection.connect()
        })

        it('DBM propagation should handle special characters', done => {
          connection.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(connection._protocol._queue[0].sql,
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
          await agent.load('mysql', { dbmPropagationMode: 'full', service: 'post' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          connection = mysql.createConnection({
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
          connection.query('SELECT 1 + 1 AS solution', () => {
            queryText = connection._protocol._queue[0].sql
          })
        })

        it('query text should contain rejected sampling decision in the traceparent', done => {
          global._ddtrace._tracer.configure({ env: 'tester', sampler: { sampleRate: 0 } })
          let queryText = ''

          agent.assertSomeTraces(traces => {
            assert.match(queryText, /-00'\*\/ SELECT 1 \+ 1 AS solution/)
          }).then(done, done)

          connection.query('SELECT 1 + 1 AS solution', () => {
            queryText = connection._protocol._queue[0].sql
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
          await agent.load('mysql', { dbmPropagationMode: 'service', service: 'post' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          pool = mysql.createPool({
            connectionLimit: 1,
            host: '127.0.0.1',
            user: 'root',
            database: 'db',
          })
        })

        it('should contain comment in query text', done => {
          pool.query('SELECT 1 + 1 AS solution', () => {
            try {
              assert.strictEqual(pool._allConnections[0]._protocol._queue[0].sql,
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
          await agent.load('mysql', { dbmPropagationMode: 'full', service: 'post' })
          mysql = proxyquire(`../../../versions/mysql@${version}`, {}).get()

          pool = mysql.createPool({
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
          pool.query('SELECT 1 + 1 AS solution', () => {
            queryText = pool._allConnections[0]._protocol._queue[0].sql
          })
        })

        it('query text should contain rejected sampling decision in the traceparent', done => {
          global._ddtrace._tracer.configure({ env: 'tester', sampler: { sampleRate: 0 } })
          let queryText = ''

          agent.assertSomeTraces(() => {
            assert.match(queryText, /-00'\*\/ SELECT 1 \+ 1 AS solution/)
          }).then(done, done)

          pool.query('SELECT 1 + 1 AS solution', () => {
            queryText = pool._allConnections[0]._protocol._queue[0].sql
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
