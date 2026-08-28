'use strict'

const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const net = require('node:net')
const { performance } = require('node:perf_hooks')
const { inspect } = require('node:util')

const dc = require('dc-polyfill')
const semver = require('semver')
const sinon = require('sinon')

const ddpv = require('mocha/package.json').version
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { expectedSchema, rawExpectedSchema } = require('./naming')

const clients = {
  pg: pg => pg.Client,
}

if (process.env.PG_TEST_NATIVE === 'true') {
  clients['pg.native'] = pg => pg.native.Client
}

const POSTGRES_TARGET = {
  host: '127.0.0.1',
  user: 'postgres',
  password: 'postgres',
  database: 'postgres',
  application_name: 'test',
}

/**
 * @param {Record<string, string | number>} [overrides]
 */
function poolOptions (overrides) {
  return { ...POSTGRES_TARGET, max: 1, ...overrides }
}

/**
 * @param {number} start
 * @param {(advanceTo: (value: number) => void) => Promise<unknown>} run
 */
async function withFakeNow (start, run) {
  const nowStub = sinon.stub(performance, 'now').returns(start)

  try {
    await run(value => nowStub.returns(value))
  } finally {
    nowStub.restore()
  }
}

/**
 * Serve a port that accepts the TCP connection and destroys it, so pg fails after connecting.
 *
 * @param {(port: number) => Promise<unknown>} run
 */
async function withUnreachablePort (run) {
  const probe = net.createServer(socket => socket.destroy())
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')

  try {
    await run(probe.address().port)
  } finally {
    const closed = once(probe, 'close')
    probe.close()
    await closed
  }
}

/**
 * @param {{ end: () => Promise<unknown> }} pool
 * @param {(pool: object) => Promise<unknown>} run
 */
async function withPool (pool, run) {
  try {
    await run(pool)
  } finally {
    await pool.end()
  }
}

/**
 * @param {Array<{ name: string }>} spans
 */
function findAcquireSpan (spans) {
  const span = spans.find(candidate => candidate.name.endsWith('.pool.acquire'))
  assert.ok(span, `missing acquire span: ${inspect(spans.map(candidate => candidate.name))}`)
  return span
}

/**
 * The body owns `release` on success so a test can time it; a throwing body releases with the error.
 *
 * @param {{ connect: Function }} pool
 * @param {(client: object, release: (error?: unknown) => void) => unknown} run
 */
function acquireWithCallback (pool, run) {
  return new Promise((resolve, reject) => {
    pool.connect((error, client, release) => {
      if (error) {
        reject(error)
        return
      }

      Promise.resolve(run(client, release)).then(resolve, failure => {
        release(failure)
        reject(failure)
      })
    })
  })
}

describe('Plugin', () => {
  let pg
  let client
  let tracer

  describe('pg', () => {
    withVersions('pg', 'pg', (version) => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      Object.keys(clients).forEach(implementation => {
        describe(`when using ${implementation}.Client`, () => {
          before(() => {
            return agent.load('pg')
          })

          after(() => {
            return agent.close()
          })

          beforeEach(done => {
            pg = require(`../../../versions/pg@${version}`).get()

            const Client = clients[implementation](pg)

            client = new Client({
              host: '127.0.0.1',
              user: 'postgres',
              password: 'postgres',
              database: 'postgres',
              application_name: 'test',
            })

            client.connect(err => done(err))
          })

          withPeerService(
            () => tracer,
            'pg',
            (done) => client.query('SELECT 1', done),
            'postgres',
            'db.name'
          )

          it('should do automatic instrumentation when using callbacks', done => {
            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
              assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
              assert.strictEqual(traces[0][0].resource, 'SELECT $1::text as message')
              assert.strictEqual(traces[0][0].type, 'sql')
              assertObjectContains(traces[0][0], {
                meta: {
                  'span.kind': 'client',
                  'db.name': 'postgres',
                  'db.user': 'postgres',
                  'db.type': 'postgres',
                  component: 'pg',
                  '_dd.integration': 'pg',
                },
                metrics: {
                  'network.destination.port': 5432,
                },
              })

              if (implementation !== 'pg.native') {
                assert.ok(
                  Object.hasOwn(traces[0][0].metrics, 'db.pid'),
                  `Available keys: ${inspect(Object.keys(traces[0][0].metrics))}`
                )
              }

              assert.ok(!Object.hasOwn(traces[0][0].metrics, 'db.pool.wait_time_ms'))
            }, { spanResourceMatch: /^SELECT \$1::text as message$/ })
              .then(done)
              .catch(done)

            client.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
              if (err) throw err

              client.end((err) => {
                if (err) throw err
              })
            })
          })

          it('should send long queries to agent', done => {
            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].resource, `SELECT '${'x'.repeat(5000)}'::text as message`)

              done()
            })

            client.query(`SELECT '${'x'.repeat(5000)}'::text as message`, (err, result) => {
              if (err) throw err

              client.end((err) => {
                if (err) throw err
              })
            })
          })

          {
            // initial promise support
            const promiseTest = semver.intersects(version, '>=5.1') ? it : it.skip
            promiseTest('should do automatic instrumentation when using promises', done => {
              agent.assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
                assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
                assert.strictEqual(traces[0][0].resource, 'SELECT $1::text as message')
                assert.strictEqual(traces[0][0].type, 'sql')
                assertObjectContains(traces[0][0], {
                  meta: {
                    'span.kind': 'client',
                    'db.name': 'postgres',
                    'db.user': 'postgres',
                    'db.type': 'postgres',
                    component: 'pg',
                  },
                  metrics: {
                    'network.destination.port': 5432,
                  },
                })

                if (implementation !== 'pg.native') {
                  assert.ok(
                    Object.hasOwn(traces[0][0].metrics, 'db.pid'),
                    `Available keys: ${inspect(Object.keys(traces[0][0].metrics))}`
                  )
                }
              })
                .then(done)
                .catch(done)

              client.query('SELECT $1::text as message', ['Hello world!'])
                .then(() => client.end())
                .catch(done)
            })
          }

          it('should handle callback errors', done => {
            let error

            agent.assertSomeTraces(traces => {
              assertObjectContains(traces[0][0], {
                meta: {
                  [ERROR_TYPE]: error.name,
                  [ERROR_MESSAGE]: error.message,
                  [ERROR_STACK]: error.stack,
                  component: 'pg',
                },
                metrics: {
                  'network.destination.port': 5432,
                },
              })
            })
              .then(done)
              .catch(done)

            client.query('INVALID', (err, result) => {
              error = err

              client.end((err) => {
                if (err) throw err
              })
            })
          })

          it('should handle event emitter errors', done => {
            let error

            agent.assertSomeTraces(traces => {
              assertObjectContains(traces[0][0].meta, {
                [ERROR_TYPE]: error.name,
                [ERROR_MESSAGE]: error.message,
                component: 'pg',
              })

              // pg modifies stacktraces as of v8.11.1
              const actualErrorNoStack = traces[0][0].meta[ERROR_STACK].split('\n')[0]
              const expectedErrorNoStack = error.stack.split('\n')[0]
              assert.deepStrictEqual(actualErrorNoStack, expectedErrorNoStack)
              assertObjectContains(traces[0][0].metrics, {
                'network.destination.port': 5432,
              })
            })
              .then(done)
              .catch(done)

            const errorCallback = (err) => {
              error = err

              client.end((err) => {
                if (err) throw err
              })
            }
            const query = client.query('INVALID')
            if (query.on) {
              query.on('error', errorCallback)
            } else {
              query.catch(errorCallback)
            }
          })

          it('should run the callback in the parent context', done => {
            const span = tracer.startSpan('test')

            tracer.scope().activate(span, () => {
              const span = tracer.scope().active()

              client.query('SELECT $1::text as message', ['Hello World!'], () => {
                assert.strictEqual(tracer.scope().active(), span)
                done()
              })

              client.end((err) => {
                if (err) throw err
              })
            })
          })

          withNamingSchema(
            done => client.query('SELECT $1::text as message', ['Hello world!'])
              .then(() => client.end())
              .catch(done),
            rawExpectedSchema.outbound
          )

          {
            // pg-cursor is not supported on pg.native, pg-query-stream uses pg-cursor so it is also unsupported
            const streamingSuite = implementation !== 'pg.native' ? describe : describe.skip
            streamingSuite('streaming capabilities', () => {
              withVersions('pg', 'pg-cursor', pgCursorVersion => {
                let Cursor

                beforeEach(() => {
                  Cursor = require(`../../../versions/pg-cursor@${pgCursorVersion}`).get()
                })

                it('should instrument cursor-based streaming with pg-cursor', async () => {
                  const tracingPromise = agent.assertSomeTraces(traces => {
                    assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
                    assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
                    assert.strictEqual(traces[0][0].resource, 'SELECT * FROM generate_series(0, 1) num')
                    assert.strictEqual(traces[0][0].type, 'sql')
                    assertObjectContains(traces[0][0], {
                      meta: {
                        'span.kind': 'client',
                        'db.name': 'postgres',
                        'db.type': 'postgres',
                        component: 'pg',
                      },
                      metrics: {
                        'db.stream': 1,
                        'network.destination.port': 5432,
                      },
                    })
                  })

                  const cursor = client.query(new Cursor('SELECT * FROM generate_series(0, 1) num'))

                  cursor.read(1, () => {
                    cursor.close()
                  })
                  await tracingPromise
                })
              })

              withVersions('pg', 'pg-query-stream', pgQueryStreamVersion => {
                let QueryStream

                beforeEach(() => {
                  QueryStream = require(`../../../versions/pg-query-stream@${pgQueryStreamVersion}`).get()
                })

                it('should instrument stream-based queries with pg-query-stream', async () => {
                  const agentPromise = agent.assertSomeTraces(traces => {
                    assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
                    assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
                    assert.strictEqual(traces[0][0].resource, 'SELECT * FROM generate_series(0, 1) num')
                    assert.strictEqual(traces[0][0].type, 'sql')
                    assert.strictEqual(traces[0][0].error, 0)
                    assertObjectContains(traces[0][0], {
                      meta: {
                        'span.kind': 'client',
                        'db.name': 'postgres',
                        'db.type': 'postgres',
                        component: 'pg',
                      },
                      metrics: {
                        'db.stream': 1,
                        'network.destination.port': 5432,
                      },
                    })
                  })

                  const query = new QueryStream('SELECT * FROM generate_series(0, 1) num', [])
                  const stream = client.query(query)

                  assert.strictEqual(stream.listenerCount('error'), 0)

                  const readPromise = (async () => {
                    for await (const row of stream) {
                      assert.ok(Object.hasOwn(row, 'num'), `Available keys: ${inspect(Object.keys(row))}`)
                    }
                  })()

                  await Promise.all([readPromise, agentPromise])
                })

                it('should instrument stream-based queries with pg-query-stream and catch errors', async () => {
                  const agentPromise = agent.assertSomeTraces(traces => {
                    assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
                    assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
                    assert.strictEqual(traces[0][0].resource, 'SELECT * FROM generate_series(0, 1) num')
                    assert.strictEqual(traces[0][0].type, 'sql')
                    assert.strictEqual(traces[0][0].error, 1)
                    assertObjectContains(traces[0][0], {
                      meta: {
                        'span.kind': 'client',
                        'db.name': 'postgres',
                        'db.type': 'postgres',
                        component: 'pg',
                      },
                      metrics: {
                        'db.stream': 1,
                        'network.destination.port': 5432,
                      },
                    })
                  })

                  const query = new QueryStream('SELECT * FROM generate_series(0, 1) num', [])
                  const stream = client.query(query)

                  assert.strictEqual(stream.listenerCount('error'), 0)

                  const rejectedRead = assert.rejects(async () => {
                    // eslint-disable-next-line no-unreachable-loop
                    for await (const row of stream) {
                      assert.ok(Object.hasOwn(row, 'num'), `Available keys: ${inspect(Object.keys(row))}`)
                      throw new Error('Test error')
                    }
                  }, {
                    message: 'Test error',
                  })

                  await Promise.all([rejectedRead, agentPromise])
                })
              })
            })
          }
        })
      })

      describe('when using a connection pool', () => {
        let pool

        before(() => {
          return agent.load('pg')
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          pg = require(`../../../versions/pg@${version}`).get()

          pool = new pg.Pool(poolOptions())
        })

        afterEach(() => {
          return pool.end()
        })

        withPeerService(
          () => tracer,
          'pg',
          async () => {
            const client = await pool.connect()
            client.release()
          },
          'postgres',
          'db.name',
          { resource: 'pg.pool.acquire' }
        )

        withNamingSchema(
          async () => {
            const client = await pool.connect()
            client.release()
          },
          rawExpectedSchema.poolAcquire,
          {
            desc: 'pool acquire',
            selectSpan: traces => traces[0].find(span => span.name.endsWith('.pool.acquire')),
          }
        )

        it('resolves acquire tags for a pool configured with a connection string', async () => {
          const connectionStringPool = new pg.Pool({
            connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
            max: 1,
          })

          const tracePromise = agent.assertSomeTraces(traces => {
            const acquireSpan = findAcquireSpan(traces[0])
            assertObjectContains(acquireSpan, {
              meta: {
                'db.name': 'postgres',
                'db.user': 'postgres',
                'out.host': '127.0.0.1',
              },
              metrics: {
                'network.destination.port': 5432,
              },
            })
          })

          await withPool(connectionStringPool, async () => {
            const client = await connectionStringPool.connect()
            client.release()

            await tracePromise
          })
        })

        it('keeps tracing when an acquire finishes without a matching start', async () => {
          dc.channel('apm:pg:pool:acquire:finish').publish({ poolWaitTime: 1 })

          await Promise.all([
            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta['db.type'], 'postgres')
            }, { spanResourceMatch: /^SELECT 15 AS survivor$/ }),
            pool.query('SELECT 15 AS survivor'),
          ])
        })

        it('traces an acquire for a pool that exposes no connection options', async () => {
          const ctx = {}

          const tracePromise = agent.assertSomeTraces(traces => {
            const acquireSpan = findAcquireSpan(traces[0])
            assert.strictEqual(acquireSpan.meta['db.type'], 'postgres')
            assert.strictEqual(acquireSpan.meta['db.name'], undefined)
          })

          dc.channel('apm:pg:pool:acquire:start').publish(ctx)
          dc.channel('apm:pg:pool:acquire:finish').publish(ctx)

          await tracePromise
        })

        it('keeps a query that waits for a busy pool parented to its own caller', done => {
          const root = tracer.startSpan('root')
          const parent1 = tracer.startSpan('parent1', { childOf: root })
          const parent2 = tracer.startSpan('parent2', { childOf: root })

          agent.assertSomeTraces(traces => {
            const spans = traces[0]
            const first = spans.find(span => span.resource === 'SELECT 1 AS one')
            const second = spans.find(span => span.resource === 'SELECT 2 AS two')

            assert.ok(first, `missing first query span: ${inspect(spans.map(span => span.resource))}`)
            assert.ok(second, `missing second query span: ${inspect(spans.map(span => span.resource))}`)
            assert.strictEqual(first.parent_id.toString(), parent1.context().toSpanId())
            assert.strictEqual(second.parent_id.toString(), parent2.context().toSpanId())
          })
            .then(done)
            .catch(done)

          let remaining = 2
          const settle = error => {
            if (error) {
              done(error)
            } else if (--remaining === 0) {
              parent1.finish()
              parent2.finish()
              root.finish()
            }
          }

          // Both queries are dispatched in the same tick with `max: 1`, so the second one
          // waits in the pool's pending queue and its connect callback fires from the first
          // query's release flow — the async context that drops on master.
          tracer.scope().activate(parent1, () => {
            pool.query('SELECT 1 AS one', settle)
          })

          tracer.scope().activate(parent2, () => {
            pool.query('SELECT 2 AS two', settle)
          })
        })

        it('keeps a promise-acquired pooled query parented to its caller', async () => {
          const parent = tracer.startSpan('promise-parent')

          const tracePromise = agent.assertSomeTraces(traces => {
            const span = traces[0].find(query => query.resource === 'SELECT 3 AS three')

            assert.ok(span, `missing query span: ${inspect(traces[0].map(query => query.resource))}`)
            assert.strictEqual(span.parent_id.toString(), parent.context().toSpanId())
          })

          await tracer.scope().activate(parent, async () => {
            const client = await pool.connect()
            await client.query('SELECT 3 AS three')
            client.release()
            parent.finish()
          })

          await tracePromise
        })

        it('records the wait of an acquire that opens a new connection', async () => {
          const tracePromise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].metrics['db.pool.wait_time_ms'], 50)
          }, { spanResourceMatch: /^SELECT 4 AS pool_wait_probe$/ })

          await withFakeNow(100, async advanceTo => {
            const queryPromise = pool.query('SELECT 4 AS pool_wait_probe')
            advanceTo(150)

            await Promise.all([
              tracePromise,
              queryPromise,
            ])
          })
        })

        it('reports a zero wait time when an idle pooled client is reused', async () => {
          await pool.query('SELECT 1')

          await Promise.all([
            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].metrics['db.pool.wait_time_ms'], 0)
            }, { spanResourceMatch: /^SELECT 7 AS idle_probe$/ }),
            pool.query('SELECT 7 AS idle_probe'),
          ])
        })

        it('reports a queued warm-pool wait without charging the first idle handoff', async () => {
          await pool.query('SELECT 1')

          const tracePromise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].metrics['db.pool.wait_time_ms'], 50)
          }, { spanResourceMatch: /^SELECT 9 AS queued_probe$/ })

          await withFakeNow(100, async advanceTo => {
            const idleQuery = pool.query('SELECT 8 AS idle_taker')
            const queuedQuery = pool.query('SELECT 9 AS queued_probe')
            advanceTo(150)

            await Promise.all([
              tracePromise,
              idleQuery,
              queuedQuery,
            ])
          })
        })

        it('keeps a concurrent acquire on another pool independent', async () => {
          const otherPool = new pg.Pool(poolOptions())

          let starvedWaitTime
          let idleWaitTime
          let heldClient
          let released = false

          try {
            await otherPool.query('SELECT 1')
            heldClient = await pool.connect()

            await withFakeNow(100, async advanceTo => {
              const starvedTrace = agent.assertSomeTraces(traces => {
                starvedWaitTime = traces[0][0].metrics['db.pool.wait_time_ms']
              }, { spanResourceMatch: /^SELECT 5 AS starved_probe$/ })
              const idleTrace = agent.assertSomeTraces(traces => {
                idleWaitTime = traces[0][0].metrics['db.pool.wait_time_ms']
              }, { spanResourceMatch: /^SELECT 6 AS other_pool_probe$/ })
              const starvedQuery = pool.query('SELECT 5 AS starved_probe')
              const idleQuery = otherPool.query('SELECT 6 AS other_pool_probe')

              advanceTo(150)
              heldClient.release()
              released = true

              await Promise.all([starvedTrace, idleTrace, starvedQuery, idleQuery])
            })
          } finally {
            if (heldClient !== undefined && !released) {
              heldClient.release()
            }
            await otherPool.end()
          }

          assert.strictEqual(starvedWaitTime, 50)
          assert.strictEqual(idleWaitTime, 0)
        })

        it('reports an explicit acquire on its own span and leaves every query span untagged', async () => {
          const standalone = new pg.Client(POSTGRES_TARGET)

          await standalone.connect()

          const parent = tracer.startSpan('unrelated-client-parent')

          const tracePromise = agent.assertSomeTraces(traces => {
            const acquireSpan = traces[0].find(span => span.name === 'pg.pool.acquire')
            const unrelatedSpan = traces[0].find(span => span.resource === 'SELECT 10 AS unrelated_probe')
            const acquiredSpan = traces[0].find(span => span.resource === 'SELECT 11 AS acquired_probe')

            assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)

            const waitTime = acquireSpan.metrics['db.pool.wait_time_ms']
            assert.strictEqual(typeof waitTime, 'number')

            assert.ok(unrelatedSpan, `missing unrelated span: ${inspect(traces[0].map(span => span.resource))}`)
            assert.ok(!Object.hasOwn(unrelatedSpan.metrics, 'db.pool.wait_time_ms'))

            assert.ok(acquiredSpan, `missing acquired span: ${inspect(traces[0].map(span => span.resource))}`)
            assert.ok(!Object.hasOwn(acquiredSpan.metrics, 'db.pool.wait_time_ms'))
          })

          try {
            const operation = tracer.scope().activate(parent, () => {
              return acquireWithCallback(pool, async (client, release) => {
                await Promise.all([
                  standalone.query('SELECT 10 AS unrelated_probe'),
                  client.query('SELECT 11 AS acquired_probe'),
                ])
                release()
                parent.finish()
              })
            })

            await Promise.all([tracePromise, operation])
          } finally {
            await standalone.end()
          }
        })

        it('gives an acquire nested in a release its own wait', async () => {
          const parent = tracer.startSpan('nested-acquire-parent')

          const tracePromise = agent.assertSomeTraces(traces => {
            const waits = traces[0]
              .filter(span => span.name === 'pg.pool.acquire')
              .map(span => span.metrics['db.pool.wait_time_ms'])

            assert.deepStrictEqual(waits, [10, 10])
          })

          await withFakeNow(100, async advanceTo => {
            const operation = tracer.scope().activate(parent, () => {
              return acquireWithCallback(pool, (client, release) => {
                const nested = acquireWithCallback(pool, async (nestedClient, nestedRelease) => {
                  await nestedClient.query('SELECT 12 AS nested_probe')
                  nestedRelease()
                  parent.finish()
                })

                advanceTo(120)
                release()

                return nested
              })
            })

            advanceTo(110)

            await Promise.all([tracePromise, operation])
          })
        })

        it('records an acquire error when a pooled query cannot connect', async () => {
          await withUnreachablePort(async port => {
            const failingPool = new pg.Pool(poolOptions({ port, connectionTimeoutMillis: 500 }))
            failingPool.on('error', () => {})

            await withPool(failingPool, async () => {
              await Promise.all([
                agent.assertSomeTraces(traces => {
                  const acquireSpan = findAcquireSpan(traces[0])

                  assert.strictEqual(acquireSpan.error, 1)
                  assert.strictEqual(typeof acquireSpan.metrics['db.pool.wait_time_ms'], 'number')
                }),
                new Promise((resolve, reject) => {
                  failingPool.query('SELECT 1', error => {
                    return error ? resolve() : reject(new Error('expected acquire error'))
                  })
                }),
              ])
            })
          })
        })

        it('creates a dedicated acquire span for an explicit promise pool.connect()', async () => {
          const parent = tracer.startSpan('acquire-promise-parent')

          const tracePromise = agent.assertSomeTraces(traces => {
            const acquireSpan = traces[0].find(span => span.name === 'pg.pool.acquire')
            const querySpan = traces[0].find(span => span.resource === 'SELECT 5 AS five')

            assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
            assert.strictEqual(acquireSpan.parent_id.toString(), parent.context().toSpanId())
            assert.strictEqual(typeof acquireSpan.metrics['db.pool.wait_time_ms'], 'number')
            assert.ok(acquireSpan.metrics['db.pool.wait_time_ms'] >= 0)

            assert.ok(querySpan, `missing query span: ${inspect(traces[0].map(span => span.resource))}`)
            assert.ok(!Object.hasOwn(querySpan.metrics, 'db.pool.wait_time_ms'))
          })

          await Promise.all([
            tracePromise,
            tracer.scope().activate(parent, async () => {
              const client = await pool.connect()
              await client.query('SELECT 5 AS five')
              client.release()
              parent.finish()
            }),
          ])
        })

        it('keeps the acquire wait when an async callback defers its query', async () => {
          const blocker = await pool.connect()
          const parent = tracer.startSpan('acquire-callback-parent')
          let blockerReleased = false

          const tracePromise = agent.assertSomeTraces(traces => {
            const acquireSpan = traces[0].find(span => span.name === 'pg.pool.acquire')
            const querySpan = traces[0].find(span => span.resource === 'SELECT 14 AS deferred_probe')

            assert.ok(acquireSpan, `missing acquire span: ${inspect(traces[0].map(span => span.name))}`)
            assert.strictEqual(acquireSpan.parent_id.toString(), parent.context().toSpanId())
            assert.strictEqual(acquireSpan.metrics['db.pool.wait_time_ms'], 50)

            assert.ok(querySpan, `missing query span: ${inspect(traces[0].map(span => span.resource))}`)
            assert.ok(!Object.hasOwn(querySpan.metrics, 'db.pool.wait_time_ms'))
          })

          try {
            await withFakeNow(100, async advanceTo => {
              const operation = tracer.scope().activate(parent, () => {
                return acquireWithCallback(pool, async (client, release) => {
                  await new Promise(resolve => setImmediate(resolve))
                  await client.query('SELECT 14 AS deferred_probe')
                  release()
                  parent.finish()
                })
              })

              advanceTo(150)
              blocker.release()
              blockerReleased = true

              await Promise.all([tracePromise, operation])
            })
          } finally {
            if (!blockerReleased) {
              blocker.release()
            }
          }
        })

        it('records an error on the acquire span when an explicit connect fails', async () => {
          await withUnreachablePort(async port => {
            const failingPool = new pg.Pool({
              connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
              connectionTimeoutMillis: 500,
            })
            failingPool.on('error', () => {})

            const tracePromise = agent.assertSomeTraces(traces => {
              const acquireSpan = findAcquireSpan(traces[0])
              assert.strictEqual(acquireSpan.error, 1)
              assertObjectContains(acquireSpan, {
                meta: {
                  'db.name': 'postgres',
                  'db.user': 'postgres',
                  'out.host': '127.0.0.1',
                },
                metrics: {
                  'network.destination.port': port,
                },
              })
            })

            await withPool(failingPool, async () => {
              await Promise.all([
                assert.rejects(failingPool.connect()),
                tracePromise,
              ])
            })
          })
        })

        it('records resolved connection tags when a callback connect fails', async () => {
          await withUnreachablePort(async port => {
            const failingPool = new pg.Pool({
              connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
              connectionTimeoutMillis: 500,
            })
            failingPool.on('error', () => {})

            const tracePromise = agent.assertSomeTraces(traces => {
              const acquireSpan = findAcquireSpan(traces[0])

              assert.strictEqual(acquireSpan.error, 1)
              assertObjectContains(acquireSpan, {
                meta: {
                  'db.name': 'postgres',
                  'db.user': 'postgres',
                  'out.host': '127.0.0.1',
                },
                metrics: {
                  'network.destination.port': port,
                },
              })
            })

            await withPool(failingPool, async () => {
              const error = await new Promise(resolve => {
                failingPool.connect(resolve)
              })

              assert.ok(error, 'expected the callback connect to fail')
              await tracePromise
            })
          })
        })

        it('finishes the acquire span when connecting throws synchronously', async () => {
          const throwingPool = new pg.Pool({ connectionString: 'postgres://[invalid' })
          const parent = tracer.startSpan('sync-throw-parent')

          const tracePromise = agent.assertSomeTraces(traces => {
            const acquireSpan = findAcquireSpan(traces[0])
            assert.strictEqual(acquireSpan.error, 1)
          })

          await Promise.all([
            tracePromise,
            tracer.scope().activate(parent, async () => {
              try {
                assert.throws(() => throwingPool.connect(), { message: 'Invalid URL' })
              } finally {
                parent.finish()
              }
            }),
          ])
        })

        it('does not create an acquire span for pool.query', async () => {
          await Promise.all([
            agent.assertSomeTraces(traces => {
              assert.ok(
                !traces[0].some(span => span.name === 'pg.pool.acquire'),
                `unexpected acquire span: ${inspect(traces[0].map(span => span.name))}`
              )
            }, { spanResourceMatch: /^SELECT 6 AS six$/ }),
            pool.query('SELECT 6 AS six'),
          ])
        })
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load('pg', { service: 'custom', truncate: 12 })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(done => {
          pg = require(`../../../versions/pg@${version}`).get()

          client = new pg.Client({
            host: '127.0.0.1',
            user: 'postgres',
            password: 'postgres',
            database: 'postgres',
          })

          client.connect(err => done(err))
        })

        it('should be configured with the correct values', done => {
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
            assert.strictEqual(traces[0][0].service, 'custom')
            assert.strictEqual(traces[0][0].resource, 'SELECT $1...')
          })
            .then(done)
            .catch(done)

          client.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
            if (err) throw err

            client.end((err) => {
              if (err) throw err
            })
          })
        })

        withNamingSchema(
          done => client.query('SELECT $1::text as message', ['Hello world!'])
            .then(() => client.end())
            .catch(done),
          {
            v0: {
              opName: 'pg.query',
              serviceName: 'custom',
            },
            v1: {
              opName: 'postgresql.query',
              serviceName: 'custom',
            },
          }
        )
      })

      describe('with a service name callback', () => {
        before(() => {
          return agent.load('pg', {
            service (params) {
              if (params.application_name === 'tracer-service') return 'test'
              if (params.application_name === 'no-service') return undefined
              return `${params.host.toUpperCase()}-${params.database}`
            },
          })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(done => {
          pg = require(`../../../versions/pg@${version}`).get()

          client = new pg.Client({
            host: '127.0.0.1',
            user: 'postgres',
            password: 'postgres',
            database: 'postgres',
          })

          client.connect(err => done(err))
        })

        it('should be configured with the correct service', done => {
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, expectedSchema.outbound.opName)
            assert.strictEqual(traces[0][0].service, '127.0.0.1-postgres')
          })
            .then(done)
            .catch(done)

          client.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
            if (err) throw err

            client.end((err) => {
              if (err) throw err
            })
          })
        })

        it('resolves a pool acquire service from normalized connection parameters', async () => {
          await client.end()

          const connectionStringPool = new pg.Pool({
            connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
            max: 1,
          })
          const parent = tracer.startSpan('pool-service-parent')

          const tracePromise = agent.assertSomeTraces(traces => {
            const acquireSpan = findAcquireSpan(traces[0])
            const querySpan = traces[0].find(span => span.resource === 'SELECT 16 AS service_probe')

            assert.strictEqual(acquireSpan.service, '127.0.0.1-postgres')
            assert.strictEqual(acquireSpan.meta['_dd.svc_src'], 'opt.plugin')
            assert.ok(querySpan, `missing query span: ${inspect(traces[0].map(span => span.resource))}`)
            assert.strictEqual(querySpan.service, acquireSpan.service)
          })

          await withPool(connectionStringPool, async () => {
            await Promise.all([
              tracePromise,
              tracer.scope().activate(parent, async () => {
                let poolClient
                try {
                  poolClient = await connectionStringPool.connect()
                  await poolClient.query('SELECT 16 AS service_probe')
                } finally {
                  poolClient?.release()
                  parent.finish()
                }
              }),
            ])
          })
        })

        it('keeps the schema fallback when a pool callback returns no name', async () => {
          await client.end()

          const connectionStringPool = new pg.Pool({
            connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
            application_name: 'no-service',
            max: 1,
          })
          const parent = tracer.startSpan('no-service-parent')

          const tracePromise = agent.assertSomeTraces(traces => {
            const acquireSpan = findAcquireSpan(traces[0])
            const querySpan = traces[0].find(span => span.resource === 'SELECT 17 AS fallback_probe')

            assert.strictEqual(acquireSpan.service, 'test-postgres')
            assert.strictEqual(acquireSpan.meta['_dd.svc_src'], 'postgres')

            assert.ok(querySpan, `missing query span: ${inspect(traces[0].map(span => span.resource))}`)
            assert.strictEqual(querySpan.service, acquireSpan.service)
            assert.strictEqual(querySpan.meta['_dd.svc_src'], acquireSpan.meta['_dd.svc_src'])
          })

          await withPool(connectionStringPool, async () => {
            await Promise.all([
              tracePromise,
              tracer.scope().activate(parent, async () => {
                let poolClient
                try {
                  poolClient = await connectionStringPool.connect()
                  await poolClient.query('SELECT 17 AS fallback_probe')
                } finally {
                  poolClient?.release()
                  parent.finish()
                }
              }),
            ])
          })
        })

        it('clears the service source when a pool callback resolves to the tracer service', async () => {
          await client.end()

          const connectionStringPool = new pg.Pool({
            connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
            application_name: 'tracer-service',
            max: 1,
          })

          const tracePromise = agent.assertSomeTraces(traces => {
            const acquireSpan = findAcquireSpan(traces[0])
            assert.strictEqual(acquireSpan.service, 'test')
            assert.ok(!Object.hasOwn(acquireSpan.meta, '_dd.svc_src'))
          })

          await withPool(connectionStringPool, async () => {
            await Promise.all([
              tracePromise,
              (async () => {
                const poolClient = await connectionStringPool.connect()
                poolClient.release()
              })(),
            ])
          })
        })

        withNamingSchema(
          done => client.query('SELECT $1::text as message', ['Hello world!'])
            .then(() => client.end())
            .catch(done),
          {
            v0: {
              opName: 'pg.query',
              serviceName: '127.0.0.1-postgres',
            },
            v1: {
              opName: 'postgresql.query',
              serviceName: '127.0.0.1-postgres',
            },
          }
        )
      })

      describe('with DBM propagation enabled with service using plugin configurations', () => {
        before(() => {
          return agent.load('pg', { dbmPropagationMode: 'service', service: () => 'serviced' })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(done => {
          pg = require(`../../../versions/pg@${version}`).get()

          client = new pg.Client({
            host: '127.0.0.1',
            user: 'postgres',
            password: 'postgres',
            database: 'postgres',
          })
          client.connect(err => done(err))
        })

        it('should contain comment in query text', done => {
          const client = new pg.Client({
            host: '127.0.0.1',
            user: 'postgres',
            password: 'postgres',
            database: 'postgres',
          })

          client.connect(err => done(err))

          const queryQueueName = Object.hasOwn(client, '_queryQueue') ? '_queryQueue' : 'queryQueue'

          client.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
            if (err) return done(err)

            client.end((err) => {
              if (err) return done(err)
            })
          })
          if (client[queryQueueName][0]) {
            try {
              assert.strictEqual(client[queryQueueName][0].text,
                '/*dddb=\'postgres\',dddbs=\'serviced\',dde=\'tester\',ddh=\'127.0.0.1\',ddps=\'test\',' +
                `ddpv='${ddpv}'*/ SELECT $1::text as message`)
            } catch (e) {
              done(e)
            }
          }
        })

        it('trace query resource should not be changed when propagation is enabled', done => {
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].resource, 'SELECT $1::text as message')
            done()
          })
          client.query('SELECT $1::text as message', ['Hello world!'], (err, result) => {
            if (err) return done(err)
            client.end((err) => {
              if (err) return done(err)
            })
          })
        })
      })

      describe('DBM propagation should handle special characters', () => {
        let clientDBM

        before(() => {
          return agent.load('pg', { dbmPropagationMode: 'service', service: '~!@#$%^&*()_+|??/<>' })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(done => {
          pg = require(`../../../versions/pg@${version}`).get()

          clientDBM = new pg.Client({
            host: '127.0.0.1',
            user: 'postgres',
            password: 'postgres',
            database: 'postgres',
          })

          clientDBM.connect(err => done(err))
        })

        it('DBM propagation should handle special characters', () => {
          const queryQueueName = Object.hasOwn(clientDBM, '_queryQueue') ? '_queryQueue' : 'queryQueue'

          return new Promise((resolve, reject) => {
            let assertionError
            clientDBM.query('SELECT $1::text as message', ['Hello world!'], (error) => {
              clientDBM.end((endError) => {
                if (error) return reject(error)
                if (endError) return reject(endError)
                if (assertionError) return reject(assertionError)
                resolve()
              })
            })

            try {
              const query = clientDBM[queryQueueName][0]
              assert.ok(query)
              assert.strictEqual(query.text,
                '/*dddb=\'postgres\',dddbs=\'~!%40%23%24%25%5E%26*()_%2B%7C%3F%3F%2F%3C%3E\',dde=\'tester\',' +
                `ddh='127.0.0.1',ddps='test',ddpv='${ddpv}'*/ SELECT $1::text as message`)
            } catch (error) {
              assertionError = error
            }
          })
        })
      })

      describe('with DBM propagation enabled with full using tracer configurations', () => {
        let tracer
        let seenTraceParent
        let seenTraceId
        let seenSpanId
        const originalWrite = net.Socket.prototype.write

        before(async () => {
          net.Socket.prototype.write = function (buffer) {
            let strBuf = buffer.toString()
            if (strBuf.includes('traceparent=\'')) {
              strBuf = strBuf.split('-')
              seenTraceParent = true
              seenTraceId = strBuf[2]
              seenSpanId = strBuf[3]
            }
            return originalWrite.apply(this, arguments)
          }
          tracer = await agent.load('pg')
        })

        beforeEach(done => {
          pg = require(`../../../versions/pg@${version}`).get()

          tracer.use('pg', {
            dbmPropagationMode: 'full',
          })

          client = new pg.Client({
            host: '127.0.0.1',
            user: 'postgres',
            password: 'postgres',
            database: 'postgres',
          })
          client.connect(err => done(err))
        })

        after(() => {
          net.Socket.prototype.write = originalWrite
        })

        it('query text should contain traceparent', done => {
          agent.assertSomeTraces(traces => {
            const expectedTimePrefix = traces[0][0].meta['_dd.p.tid'].toString(16).padStart(16, '0')
            const traceId = expectedTimePrefix + traces[0][0].trace_id.toString(16).padStart(16, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')
            assert.strictEqual(seenTraceId, traceId)
            assert.strictEqual(seenSpanId, spanId)
          }).then(done, done)

          client.query('SELECT $1::text as message', ['Hello World!'], (err, result) => {
            if (err) return done(err)
            assert.strictEqual(seenTraceParent, true)
            client.end((err) => {
              if (err) return done(err)
            })
          })
        })

        it('query should inject _dd.dbm_trace_injected into span', done => {
          agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0].meta, {
              '_dd.dbm_trace_injected': 'true',
            })
            done()
          })

          client.query('SELECT $1::text as message', ['Hello World!'], (err, result) => {
            if (err) return done(err)

            client.end((err) => {
              if (err) return done(err)
            })
          })
        })

        it('service should default to tracer service name', done => {
          agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
            done()
          })

          client.query('SELECT $1::text as message', ['Hello World!'], (err, result) => {
            if (err) return done(err)

            client.end((err) => {
              if (err) return done(err)
            })
          })
        })
      })

      describe('DBM propagation enabled with full should handle query config objects', () => {
        let queryQueueName
        let tracer

        before(async () => {
          tracer = await agent.load('pg')
        })

        beforeEach(done => {
          pg = require(`../../../versions/pg@${version}`).get()

          tracer.use('pg', {
            dbmPropagationMode: 'full',
            service: 'post',
          })

          client = new pg.Client({
            host: '127.0.0.1',
            user: 'postgres',
            password: 'postgres',
            database: 'postgres',
          })

          queryQueueName = Object.hasOwn(client, '_queryQueue') ? '_queryQueue' : 'queryQueue'

          client.connect(err => done(err))
        })

        afterEach((done) => {
          client.end(done)

          global._ddtrace._tracer.configure({ env: 'tester', sampler: { sampleRate: 1 } })
        })

        it('query config objects should be handled', async () => {
          const query = {
            text: 'SELECT $1::text as message',
          }

          const queryPromise = client.query(query, ['Hello world!'])
          const queryText = client[queryQueueName][0].text

          await queryPromise

          await agent.assertSomeTraces(traces => {
            const expectedTimePrefix = traces[0][0].meta['_dd.p.tid'].toString(16).padStart(16, '0')
            const traceId = expectedTimePrefix + traces[0][0].trace_id.toString(16).padStart(16, '0')
            const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')

            assert.strictEqual(queryText,
              `/*dddb='postgres',dddbs='post',dde='tester',ddh='127.0.0.1',ddps='test',ddpv='${ddpv}',` +
              `traceparent='00-${traceId}-${spanId}-01'*/ SELECT $1::text as message`)
          })
        })

        it('query text should contain rejected sampling decision in the traceparent', async () => {
          global._ddtrace._tracer.configure({ env: 'tester', sampler: { sampleRate: 0 } })
          const query = {
            text: 'SELECT $1::text as message',
          }

          const queryPromise = client.query(query, ['Hello world!'])
          const queryText = client[queryQueueName][0].text

          await queryPromise

          await agent.assertSomeTraces(() => {
            assert.match(queryText, /-00'\*\/ SELECT \$1::text as message/)
          })
        })

        it('query config object should persist when comment is injected', done => {
          const query = {
            name: 'pgSelectQuery',
            text: 'SELECT $1::text as message',
          }

          client.query(query, ['Hello world!'], (err) => {
            done(err)
          })

          assert.strictEqual(query.name, 'pgSelectQuery')
        })

        it('falls back to service with prepared statements', done => {
          const query = {
            name: 'pgSelectQuery',
            text: 'SELECT $1::text as message',
          }

          client.query(query, ['Hello world!'], (err) => {
            done(err)
          })
          assert.strictEqual(client[queryQueueName][0].text,
            `/*dddb='postgres',dddbs='post',dde='tester',ddh='127.0.0.1',ddps='test',ddpv='${ddpv}'` +
            '*/ SELECT $1::text as message'
          )
        })

        it('reuses prepared statements across calls without "must be unique" error', async () => {
          const buildQuery = () => ({
            name: 'pgRepeatedSelect',
            text: 'SELECT $1::text as message',
          })

          await client.query(buildQuery(), ['first'])
          await client.query(buildQuery(), ['second'])
          await client.query(buildQuery(), ['third'])
        })

        it('should not fail when using query object with getters', done => {
          const query = {
            name: 'pgSelectQuery',
            get text () { return 'SELECT $1::text as message' },
          }

          client.query(query, ['Hello world!'], async (err) => {
            done(err)
          })
          assert.strictEqual(client[queryQueueName][0].text,
            `/*dddb='postgres',dddbs='post',dde='tester',ddh='127.0.0.1',ddps='test',ddpv='${ddpv}'` +
            '*/ SELECT $1::text as message')
        })

        it('does not accumulate the DBM comment when reusing a prepared-statement query object', done => {
          const expected =
            `/*dddb='postgres',dddbs='post',dde='tester',ddh='127.0.0.1',ddps='test',ddpv='${ddpv}'` +
            '*/ SELECT $1::text as message'
          const query = {
            name: 'pgSelectQuery',
            text: 'SELECT $1::text as message',
          }

          client.query(query, ['Hello world!'], (err) => {
            if (err) return done(err)

            client.query(query, ['Hello world!'], (err2) => {
              if (err2) return done(err2)

              assert.strictEqual(query.text, expected)
              done()
            })
          })
        })

        it('does not accumulate the DBM comment when reusing a getter-shaped query object', done => {
          const expected =
            `/*dddb='postgres',dddbs='post',dde='tester',ddh='127.0.0.1',ddps='test',ddpv='${ddpv}'` +
            '*/ SELECT $1::text as message'
          const query = {
            name: 'pgSelectQuery',
            get text () { return 'SELECT $1::text as message' },
          }

          client.query(query, ['Hello world!'], (err) => {
            if (err) return done(err)

            client.query(query, ['Hello world!'], (err2) => {
              if (err2) return done(err2)

              assert.strictEqual(query.text, expected)
              done()
            })
          })
        })

        it('handles a non-configurable text property without crashing', done => {
          const query = { name: 'pgSelectQuery' }
          Object.defineProperty(query, 'text', {
            value: 'SELECT $1::text as message',
            writable: true,
            enumerable: true,
            configurable: false,
          })

          client.query(query, ['Hello world!'], (err) => {
            if (err) return done(err)

            assert.strictEqual(query.text, 'SELECT $1::text as message')
            done()
          })
        })

        it('should not fail when using query object that is an EventEmitter', done => {
          class Query extends EventEmitter {
            constructor (name, text) {
              super()
              this.name = name
              this._internalText = text
            }

            get text () {
              assert.deepStrictEqual(typeof this.on, 'function')
              return this._internalText
            }
          }

          const query = new Query('pgSelectQuery', 'SELECT $1::text as greeting')

          client.query(query, ['Goodbye'], (err) => {
            done(err)
          })
          assert.strictEqual(client[queryQueueName][0].text,
            `/*dddb='postgres',dddbs='post',dde='tester',ddh='127.0.0.1',ddps='test',ddpv='${ddpv}'` +
            '*/ SELECT $1::text as greeting')
        })
      })

      describe('with DBM propagation enabled with append comment configurations', () => {
        before(async () => {
          await agent.load('pg', {
            appendComment: true,
            dbmPropagationMode: 'service',
            service: () => 'serviced',
          })
          pg = require(`../../../versions/pg@${version}`).get()
        })

        after(() => {
          return agent.close()
        })

        beforeEach((done) => {
          client = new pg.Client({
            host: '127.0.0.1',
            user: 'postgres',
            password: 'postgres',
            database: 'postgres',
          })
          client.connect(err => done(err))
        })

        afterEach((done) => {
          client.end(done)
        })

        it('should append comment in query text', async () => {
          const queryQueueName = Object.hasOwn(client, '_queryQueue') ? '_queryQueue' : 'queryQueue'

          const queryPromise = client.query('SELECT $1::text as message', ['Hello world!'])

          assert.strictEqual(client[queryQueueName][0].text,
            'SELECT $1::text as message /*dddb=\'postgres\',dddbs=\'serviced\',dde=\'tester\',' +
              `ddh='127.0.0.1',ddps='test',ddpv='${ddpv}'*/`
          )

          await queryPromise
        })
      })
    })

    describe('without pg plugin subscribers', () => {
      const queryPoolStartChannel = dc.channel('datadog:pg:pool:query:start')
      const connectionStartChannel = dc.channel('apm:pg:pool:connect:start')
      let Pool
      let pool

      before(async () => {
        await agent.load([])
        Pool = require('../../../versions/pg').get().Pool

        pool = new Pool({
          host: '127.0.0.1',
          user: 'postgres',
          password: 'postgres',
          database: 'postgres',
          application_name: 'test',
          max: 1,
        })
      })

      after(async () => {
        await pool.end()
        await agent.close()
      })

      it('forwards pool queries and explicit connects', async () => {
        await pool.query('SELECT 1')

        const client = await pool.connect()
        client.release()
      })

      it('forwards pool queries with only pool-query subscribers', async () => {
        const observeQuery = () => {}
        queryPoolStartChannel.subscribe(observeQuery)

        try {
          await pool.query('SELECT 1')
        } finally {
          queryPoolStartChannel.unsubscribe(observeQuery)
        }
      })

      it('forwards pooled-query acquire errors without acquire subscribers', async () => {
        await withUnreachablePort(async port => {
          const failingPool = new Pool(poolOptions({ port, connectionTimeoutMillis: 500 }))
          const observeAcquire = () => {}
          connectionStartChannel.subscribe(observeAcquire)

          try {
            await assert.rejects(failingPool.query('SELECT 1'), Error)
          } finally {
            connectionStartChannel.unsubscribe(observeAcquire)
            await failingPool.end()
          }
        })
      })
    })

    // Lives outside `withVersions` so the global-tracer wipe needed to test
    // tracer-level config (third `agent.load` arg) does not strand sibling
    // describe blocks in the next pg-version iteration.
    describe('with DBM propagation enabled with append comment using tracer configuration', () => {
      before(async () => {
        // Tracer-level config (third arg) only takes effect if the global
        // tracer is wiped first; tracer.init() short-circuits once the
        // process-wide singleton has been initialized by an earlier load.
        await agent.load('pg', {
          appendComment: true,
          service: () => 'serviced',
        }, {
          dbmPropagationMode: 'service',
        })
        pg = require('../../../versions/pg').get()
      })

      after(() => {
        return agent.close()
      })

      beforeEach((done) => {
        client = new pg.Client({
          host: '127.0.0.1',
          user: 'postgres',
          password: 'postgres',
          database: 'postgres',
        })
        client.connect(err => done(err))
      })

      afterEach((done) => {
        client.end(done)
      })

      it('should append service mode comment in query text', async () => {
        const queryQueueName = Object.hasOwn(client, '_queryQueue') ? '_queryQueue' : 'queryQueue'

        const queryPromise = client.query('SELECT $1::text as message', ['Hello world!'])

        assert.strictEqual(client[queryQueueName][0].text,
          'SELECT $1::text as message /*dddb=\'postgres\',dddbs=\'serviced\',dde=\'tester\',' +
            `ddh='127.0.0.1',ddps='test',ddpv='${ddpv}'*/`
        )

        await queryPromise
      })
    })
  })
})
