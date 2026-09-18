'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { after, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const ddpv = require('mocha/package.json').version
const { storage } = require('../../datadog-core')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { expectedSchema, rawExpectedSchema } = require('./naming')
const hostname = 'localhost'
// TODO: Use another port or db instance to differentiate it better from defaults
const port = '1521'
const dbInstance = 'xepdb1'

const config = {
  user: 'test',
  password: 'Oracle18',
  connectString: `${hostname}:${port}/${dbInstance}`,
}

const dbQuery = 'select current_timestamp from dual'
const expectedPoolAcquireSpan = {
  name: expectedSchema.poolAcquire.opName,
  service: expectedSchema.poolAcquire.serviceName,
  resource: expectedSchema.poolAcquire.opName,
  type: 'sql',
  meta: {
    'span.kind': 'client',
    component: 'oracledb',
    'db.user': config.user,
    'db.instance': dbInstance,
    'db.name': dbInstance,
    'db.hostname': hostname,
    'out.host': hostname,
    'network.destination.port': port,
  },
}

describe('Plugin', () => {
  let oracledb
  let connection
  let pool
  let tracer

  describe('oracledb', () => {
    withVersions('oracledb', 'oracledb', version => {
      describe('without configuration', () => {
        before(async () => {
          await agent.load('oracledb')
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          tracer = require('../../dd-trace')
        })

        after(async () => {
          await agent.close()
        })

        describe('with connection', () => {
          before(async () => {
            connection = await oracledb.getConnection(config)
          })

          after(async () => {
            await connection.close()
          })

          withNamingSchema(
            () => connection.execute(dbQuery),
            rawExpectedSchema.outbound
          )

          withPeerService(
            () => tracer,
            'oracledb',
            () => connection.execute(dbQuery),
            dbInstance,
            'db.instance'
          )

          connectionTests()
        })

        describe('with connection and connect descriptor', () => {
          before(async () => {
            connection = await oracledb.getConnection({
              ...config,
              connectString: `
                (DESCRIPTION=
                  (ADDRESS=(PROTOCOL=TCP)(HOST=${hostname})(PORT=1521))
                  (CONNECT_DATA=(SERVER=DEDICATED)(SERVICE_NAME=xepdb1))
                )
              `,
            })
          })

          after(async () => {
            await connection.close()
          })

          connectionTests()
        })

        describe('with connection and Easy Connect protocol', () => {
          before(async () => {
            connection = await oracledb.getConnection({
              ...config,
              connectString: `tcp://${config.connectString}`,
            })
          })

          after(async () => {
            await connection.close()
          })

          it('should use the parsed connection tags', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({
                meta: {
                  'db.instance': dbInstance,
                  'db.name': dbInstance,
                  'db.hostname': hostname,
                  'out.host': hostname,
                  'network.destination.port': port,
                },
              }),
              connection.execute(dbQuery),
            ])
          })
        })

        function connectionTests () {
          it('should be instrumented for promise API', async () => {
            connection.execute(dbQuery)

            await agent.assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: dbQuery,
              type: 'sql',
              meta: {
                'span.kind': 'client',
                component: 'oracledb',
                'db.instance': dbInstance,
                'db.name': dbInstance,
                'db.hostname': hostname,
                'out.host': hostname,
                'network.destination.port': port,
              },
            })
          })

          it('should restore the parent context in the promise callback', () => {
            const span = tracer.startSpan('test')
            return tracer.scope().activate(span, async () => {
              await connection.execute(dbQuery)
              assert.strictEqual(tracer.scope().active(), span)
            })
          })

          it('should be instrumented for callback API', done => {
            agent.assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: dbQuery,
              type: 'sql',
              meta: {
                'span.kind': 'client',
                component: 'oracledb',
                'db.instance': dbInstance,
                'db.name': dbInstance,
                'db.hostname': hostname,
                'out.host': hostname,
                'network.destination.port': port,
              },
            }).then(done, done)

            connection.execute(dbQuery, err => err && done(err))
          })

          it('should restore the parent context in the callback', done => {
            const span = tracer.startSpan('test')
            tracer.scope().activate(span, () => {
              connection.execute(dbQuery, () => {
                try {
                  assert.strictEqual(tracer.scope().active(), span)
                } catch (e) {
                  return done(e)
                }
                done()
              })
            })
          })

          it('should instrument errors', async () => {
            let error
            let resolver
            const promise = new Promise((resolve) => {
              resolver = resolve
            })
            connection.execute('invalid', err => {
              error = err
              resolver()
            })

            await promise

            await agent.assertFirstTraceSpan({
              name: expectedSchema.outbound.opName,
              service: expectedSchema.outbound.serviceName,
              resource: 'invalid',
              type: 'sql',
              meta: {
                'span.kind': 'client',
                component: 'oracledb',
                'db.instance': dbInstance,
                'db.name': dbInstance,
                'db.hostname': hostname,
                'out.host': hostname,
                'network.destination.port': port,
                [ERROR_MESSAGE]: error.message,
                [ERROR_TYPE]: error.name,
                [ERROR_STACK]: error.stack,
              },
            })
          })
        }

        describe('with pool', () => {
          before(async () => {
            pool = await oracledb.createPool(config)
            const result = await Promise.all([
              agent.assertFirstTraceSpan(expectedPoolAcquireSpan, {
                spanResourceMatch: /^oracle\.pool\.acquire$/,
              }),
              pool.getConnection(),
            ])
            connection = result[1]
          })

          after(async () => {
            await connection.close()
            await pool.close()
          })

          poolTests()

          withNamingSchema(async () => {
            const namingConnection = await pool.getConnection()
            await namingConnection.close()
          }, rawExpectedSchema.poolAcquire)

          withPeerService(
            () => tracer,
            'oracledb',
            () => connection.execute(dbQuery),
            dbInstance,
            'db.instance'
          )

          withPeerService(
            () => tracer,
            'oracledb',
            async () => {
              const peerConnection = await pool.getConnection()
              await peerConnection.close()
            },
            dbInstance,
            'db.instance'
          )
        })

        describe('with pool and connect descriptor', () => {
          before(async () => {
            pool = await oracledb.createPool({
              ...config,
              connectString: `
                (DESCRIPTION=
                  (ADDRESS=(PROTOCOL=TCP)(HOST=${hostname})(PORT=1521))
                  (CONNECT_DATA=(SERVER=DEDICATED)(SERVICE_NAME=xepdb1))
                )
              `,
            })
            const result = await Promise.all([
              agent.assertFirstTraceSpan(expectedPoolAcquireSpan, {
                spanResourceMatch: /^oracle\.pool\.acquire$/,
              }),
              pool.getConnection(),
            ])
            connection = result[1]
          })

          after(async () => {
            await connection.close()
            await pool.close()
          })

          poolTests()
        })

        describe('pool acquisition lifecycle', () => {
          let lifecyclePool

          before(async () => {
            lifecyclePool = await oracledb.createPool(config)
          })

          after(async () => {
            await lifecyclePool.close()
          })

          it('traces an idle acquisition that is released without a query', async () => {
            const idlePool = await oracledb.createPool({
              ...config,
              poolMin: 1,
            })
            let acquiredConnection

            try {
              const result = await Promise.all([
                agent.assertFirstTraceSpan(expectedPoolAcquireSpan, {
                  spanResourceMatch: /^oracle\.pool\.acquire$/,
                }),
                idlePool.getConnection({ tag: '', matchAnyTag: false }),
              ])
              acquiredConnection = result[1]
              await acquiredConnection.close()
              acquiredConnection = undefined
            } finally {
              if (acquiredConnection !== undefined) await acquiredConnection.close()
              await idlePool.close()
            }
          })

          it('keeps a queued acquisition open until a connection is available', async () => {
            const queuePool = await oracledb.createPool({
              ...config,
              poolMax: 1,
              poolMin: 0,
              queueMax: 1,
            })
            let heldConnection
            let queuedConnection

            try {
              const firstResult = await Promise.all([
                agent.assertFirstTraceSpan(expectedPoolAcquireSpan, {
                  spanResourceMatch: /^oracle\.pool\.acquire$/,
                }),
                queuePool.getConnection(),
              ])
              heldConnection = firstResult[1]

              let traceFinished = false
              const tracePromise = agent.assertFirstTraceSpan(span => {
                traceFinished = true
                assertObjectContains(span, expectedPoolAcquireSpan)
              }, { spanResourceMatch: /^oracle\.pool\.acquire$/ })
              const queuedPromise = queuePool.getConnection()

              await new Promise(resolve => setImmediate(resolve))
              assert.strictEqual(traceFinished, false)

              await heldConnection.close()
              heldConnection = undefined
              queuedConnection = await queuedPromise
              await tracePromise
              await queuedConnection.close()
              queuedConnection = undefined
            } finally {
              if (heldConnection !== undefined) await heldConnection.close()
              if (queuedConnection !== undefined) await queuedConnection.close()
              await queuePool.close()
            }
          })

          it('keeps session callback queries inside acquisition spans and restores callback context', async () => {
            const callbackQuery = 'select sys_context(\'userenv\', \'session_user\') from dual'
            const sessionPool = await oracledb.createPool({
              ...config,
              poolMax: 1,
              poolMin: 0,
              sessionCallback (callbackConnection, requestedTag, callback) {
                assert.strictEqual(requestedTag, '')
                callbackConnection.execute(callbackQuery, callback)
              },
            })
            const parent = tracer.startSpan('oracle-session-callback-parent')
            let acquiredConnection
            const tracePromise = agent.assertSomeTraces(traces => {
              const spans = traces.flat()
              const acquire = spans.find(span => span.name === expectedSchema.poolAcquire.opName)
              const query = spans.find(span => span.resource === callbackQuery)

              assert.ok(acquire)
              assert.ok(query)
              assert.strictEqual(acquire.parent_id.toString(), parent.context().toSpanId())
              assert.strictEqual(query.parent_id.toString(), acquire.span_id.toString())
            })

            try {
              await tracer.scope().activate(parent, () => {
                return new Promise((resolve, reject) => {
                  const returnValue = sessionPool.getConnection((connectionError, callbackConnection) => {
                    if (connectionError) return reject(connectionError)
                    try {
                      acquiredConnection = callbackConnection
                      assert.strictEqual(tracer.scope().active(), parent)
                      resolve()
                    } catch (error) {
                      reject(error)
                    }
                  })
                  assert.strictEqual(returnValue, undefined)
                })
              })
              await acquiredConnection.close()
              acquiredConnection = undefined
            } finally {
              if (acquiredConnection !== undefined) await acquiredConnection.close()
              parent.finish()
              await sessionPool.close()
            }
            await tracePromise
          })

          it('keeps acquisition and query spans separate and restores Promise context', async () => {
            const parent = tracer.startSpan('oracle-pool-parent')
            let acquiredConnection
            const tracePromise = agent.assertSomeTraces(traces => {
              const spans = traces.flat()
              const acquire = spans.find(span => span.name === expectedSchema.poolAcquire.opName)
              const query = spans.find(span => span.resource === dbQuery)

              assert.ok(acquire)
              assert.ok(query)
              assert.strictEqual(acquire.parent_id.toString(), parent.context().toSpanId())
              assert.strictEqual(query.parent_id.toString(), parent.context().toSpanId())
              assert.strictEqual(query.metrics['db.pool.wait_time_ms'], undefined)
            })

            try {
              await tracer.scope().activate(parent, async () => {
                acquiredConnection = await lifecyclePool.getConnection()
                assert.strictEqual(tracer.scope().active(), parent)
                await acquiredConnection.execute(dbQuery)
                assert.strictEqual(tracer.scope().active(), parent)
              })
            } finally {
              if (acquiredConnection !== undefined) await acquiredConnection.close()
              parent.finish()
            }
            await tracePromise
          })

          it('restores callback context and preserves the callback return contract', async () => {
            const parent = tracer.startSpan('oracle-pool-callback-parent')
            let acquiredConnection
            let returnValue
            const tracePromise = agent.assertSomeTraces(traces => {
              const acquire = traces.flat().find(span => span.name === expectedSchema.poolAcquire.opName)

              assert.ok(acquire)
              assert.strictEqual(acquire.parent_id.toString(), parent.context().toSpanId())
            })

            try {
              await tracer.scope().activate(parent, () => {
                return new Promise((resolve, reject) => {
                  returnValue = lifecyclePool.getConnection((error, callbackConnection) => {
                    try {
                      assert.ifError(error)
                      acquiredConnection = callbackConnection
                      assert.strictEqual(tracer.scope().active(), parent)
                      resolve()
                    } catch (error) {
                      reject(error)
                    }
                  })
                  assert.strictEqual(returnValue, undefined)
                })
              })
            } finally {
              if (acquiredConnection !== undefined) await acquiredConnection.close()
              parent.finish()
            }
            await tracePromise
          })

          it('traces Promise and callback validation errors', async () => {
            const parent = tracer.startSpan('oracle-pool-error-parent')
            const errors = []
            const tracePromise = agent.assertSomeTraces(traces => {
              const acquireSpans = traces.flat().filter(span => span.name === expectedSchema.poolAcquire.opName)

              assert.strictEqual(acquireSpans.length, 2)
              for (const [index, span] of acquireSpans.entries()) {
                assert.strictEqual(span.meta[ERROR_MESSAGE], errors[index].message)
                assert.strictEqual(span.meta[ERROR_TYPE], errors[index].name)
                assert.strictEqual(span.meta[ERROR_STACK], errors[index].stack)
              }
            })

            try {
              await tracer.scope().activate(parent, async () => {
                await assert.rejects(lifecyclePool.getConnection(null), error => {
                  errors.push(error)
                  assert.match(error.message, /^NJS-005:/)
                  return true
                })

                await new Promise((resolve, reject) => {
                  const returnValue = lifecyclePool.getConnection(null, error => {
                    try {
                      errors.push(error)
                      assert.match(error.message, /^NJS-005:/)
                      resolve()
                    } catch (error) {
                      reject(error)
                    }
                  })
                  assert.strictEqual(returnValue, undefined)
                })
              })
            } finally {
              parent.finish()
            }
            await tracePromise
          })
        })

        function poolTests () {
          it('should be instrumented correctly with correct tags', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: expectedSchema.outbound.serviceName,
                resource: dbQuery,
                type: 'sql',
                meta: {
                  'span.kind': 'client',
                  component: 'oracledb',
                  'db.instance': dbInstance,
                  'db.hostname': hostname,
                  'network.destination.port': port,
                },
              }),
              connection.execute(dbQuery),
            ])
          })

          it('should restore the parent context in the callback', async () => {
            await connection.execute(dbQuery)
            assert.strictEqual(tracer.scope().active(), null)
          })

          it('should instrument pool.getConnection with a callback', async () => {
            const result = await Promise.all([
              agent.assertFirstTraceSpan(expectedPoolAcquireSpan, {
                spanResourceMatch: /^oracle\.pool\.acquire$/,
              }),
              new Promise((resolve, reject) => {
                pool.getConnection((error, conn) => error ? reject(error) : resolve(conn))
              }),
            ])
            const callbackConnection = result[1]

            try {
              await Promise.all([
                agent.assertFirstTraceSpan({
                  name: expectedSchema.outbound.opName,
                  service: expectedSchema.outbound.serviceName,
                  resource: dbQuery,
                  type: 'sql',
                  meta: {
                    'span.kind': 'client',
                    component: 'oracledb',
                    'db.instance': dbInstance,
                  },
                }),
                callbackConnection.execute(dbQuery),
              ])
            } finally {
              await callbackConnection.close()
            }
          })

          it('should instrument errors', async () => {
            try {
              await connection.execute('invalid')
              throw new Error('Expected an error to be thrown')
            } catch (error) {
              await agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: expectedSchema.outbound.serviceName,
                resource: 'invalid',
                type: 'sql',
                meta: {
                  'span.kind': 'client',
                  component: 'oracledb',
                  'db.instance': dbInstance,
                  'db.hostname': hostname,
                  'network.destination.port': port,
                  [ERROR_MESSAGE]: error.message,
                  [ERROR_TYPE]: error.name,
                  [ERROR_STACK]: error.stack,
                },
              })
            }
          })
        }
      })

      describe('with configuration', () => {
        describe('with service returning undefined', () => {
          before(async () => {
            await agent.load('oracledb', { service () {} })
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            tracer = require('../../dd-trace')
          })

          before(async () => {
            connection = await oracledb.getConnection(config)
          })

          after(async () => {
            await connection.close()
          })

          after(async () => {
            await agent.close()
          })
          withNamingSchema(
            () => connection.execute(dbQuery),
            {
              v0: {
                opName: 'oracle.query',
                serviceName: 'test-oracle',
              },
              v1: {
                opName: 'oracle.query',
                serviceName: 'test',
              },
            }
          )

          it('should set the service name', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: 'test-oracle',
              }),
              connection.execute(dbQuery),
            ])
          })
        })

        describe('with service string', () => {
          before(async () => {
            await agent.load('oracledb', { service: 'custom' })
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            tracer = require('../../dd-trace')
          })

          before(async () => {
            connection = await oracledb.getConnection(config)
          })

          after(async () => {
            await connection.close()
          })

          after(async () => {
            await agent.close()
          })
          withNamingSchema(
            () => connection.execute(dbQuery),
            {
              v0: {
                opName: 'oracle.query',
                serviceName: 'custom',
              },
              v1: {
                opName: 'oracle.query',
                serviceName: 'custom',
              },
            }
          )

          it('should set the service name', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: 'custom',
              }),
              connection.execute(dbQuery),
            ])
          })
        })

        describe('with service function', () => {
          before(async () => {
            await agent.load('oracledb', {
              service (connAttrs) {
                assert.strictEqual(connAttrs.connectString, config.connectString)
                return connAttrs.poolAlias ?? connAttrs.connectString
              },
            })
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            tracer = require('../../dd-trace')
          })

          before(async () => {
            connection = await oracledb.getConnection(config)
          })

          after(async () => {
            await connection.close()
          })

          after(async () => {
            await agent.close()
          })
          withNamingSchema(
            () => connection.execute(dbQuery),
            {
              v0: {
                opName: 'oracle.query',
                serviceName: config.connectString,
              },
              v1: {
                opName: 'oracle.query',
                serviceName: config.connectString,
              },
            }
          )

          it('should set the service name', async () => {
            await Promise.all([
              agent.assertFirstTraceSpan({
                name: expectedSchema.outbound.opName,
                service: config.connectString,
              }),
              connection.execute(dbQuery),
            ])
          })

          it('should use pool parameters for the acquisition service name', async () => {
            const servicePool = await oracledb.createPool({
              ...config,
              poolAlias: 'service-function-pool',
            })
            let acquiredConnection

            try {
              const result = await Promise.all([
                agent.assertFirstTraceSpan({
                  name: expectedSchema.poolAcquire.opName,
                  service: 'service-function-pool',
                  resource: expectedSchema.poolAcquire.opName,
                }, { spanResourceMatch: /^oracle\.pool\.acquire$/ }),
                servicePool.getConnection(),
              ])
              acquiredConnection = result[1]
              await acquiredConnection.close()
              acquiredConnection = undefined
            } finally {
              if (acquiredConnection !== undefined) await acquiredConnection.close()
              await servicePool.close()
            }
          })
        })

        describe('with pool used via oracledb.getConnection() with no arguments', () => {
          before(async () => {
            await agent.load('oracledb', {
              service (connAttrs) {
                assert.strictEqual(connAttrs.connectString, config.connectString)
                return connAttrs.connectString
              },
            })
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            tracer = require('../../dd-trace')
          })

          after(async () => {
            await agent.close()
          })

          it('should use the pool connection attributes instead of the undefined outer call attributes', async () => {
            // node-oracledb delegates a no-argument getConnection() call to the cached default pool.
            const pool = await oracledb.createPool(config)
            const connection = await oracledb.getConnection()

            try {
              await Promise.all([
                agent.assertFirstTraceSpan({
                  service: config.connectString,
                }),
                connection.execute(dbQuery),
              ])
            } finally {
              await connection.close()
              await pool.close()
            }
          })
        })

        describe('with pool used via oracledb.getConnection(callback) with no connAttrs', () => {
          before(async () => {
            await agent.load('oracledb', {
              service (connAttrs) {
                assert.strictEqual(connAttrs.connectString, config.connectString)
                return connAttrs.connectString
              },
            })
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            tracer = require('../../dd-trace')
          })

          after(async () => {
            await agent.close()
          })

          it('should not crash and should use the pool connection attributes', async () => {
            // node-oracledb delegates a callback-only getConnection(callback) call to the cached
            // default pool, the same way a no-argument getConnection() call does for the promise API.
            const pool = await oracledb.createPool(config)
            const connection = await new Promise((resolve, reject) => {
              oracledb.getConnection((error, conn) => error ? reject(error) : resolve(conn))
            })

            try {
              await Promise.all([
                agent.assertFirstTraceSpan({
                  service: config.connectString,
                }),
                connection.execute(dbQuery),
              ])
            } finally {
              await connection.close()
              await pool.close()
            }
          })
        })
      })

      describe('with pool acquisition tracing disabled', () => {
        before(async () => {
          tracer = await agent.load('oracledb', { poolAcquire: false })
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          pool = await oracledb.createPool(config)
        })

        after(async () => {
          await pool.close()
          await agent.close()
        })

        it('keeps query tracing enabled without an acquisition span', async () => {
          const parent = tracer.startSpan('oracle-disabled-acquire-parent')
          let acquiredConnection
          let callbackConnection
          const tracePromise = agent.assertSomeTraces(traces => {
            const spans = traces.flat()

            assert.ok(spans.find(span => span.resource === dbQuery))
            assert.strictEqual(spans.some(span => span.name === expectedSchema.poolAcquire.opName), false)
          })

          try {
            await tracer.scope().activate(parent, async () => {
              acquiredConnection = await pool.getConnection()
              await acquiredConnection.execute(dbQuery)

              callbackConnection = await new Promise((resolve, reject) => {
                const returnValue = pool.getConnection((error, connection) => {
                  if (error) return reject(error)
                  resolve(connection)
                })
                assert.strictEqual(returnValue, undefined)
              })
            })
          } finally {
            if (acquiredConnection !== undefined) await acquiredConnection.close()
            if (callbackConnection !== undefined) await callbackConnection.close()
            parent.finish()
          }
          await tracePromise
        })

        it('keeps session callback queries traced without an acquisition span', async () => {
          const callbackQuery = 'select sys_context(\'userenv\', \'session_user\') from dual'
          const sessionPool = await oracledb.createPool({
            ...config,
            poolAlias: 'disabled-acquire-session',
            poolMin: 0,
            sessionCallback (callbackConnection, requestedTag, callback) {
              assert.strictEqual(requestedTag, '')
              callbackConnection.execute(callbackQuery, callback)
            },
          })
          const parent = tracer.startSpan('oracle-disabled-session-parent')
          let acquiredConnection
          const tracePromise = agent.assertSomeTraces(traces => {
            const spans = traces.flat()

            assert.ok(spans.find(span => span.resource === callbackQuery))
            assert.strictEqual(spans.some(span => span.name === expectedSchema.poolAcquire.opName), false)
          })

          try {
            await tracer.scope().activate(parent, () => {
              return new Promise((resolve, reject) => {
                const returnValue = sessionPool.getConnection((connectionError, callbackConnection) => {
                  if (connectionError) return reject(connectionError)
                  try {
                    acquiredConnection = callbackConnection
                    assert.strictEqual(tracer.scope().active(), parent)
                    resolve()
                  } catch (error) {
                    reject(error)
                  }
                })
                assert.strictEqual(returnValue, undefined)
              })
            })
          } finally {
            if (acquiredConnection !== undefined) await acquiredConnection.close()
            parent.finish()
            await sessionPool.close()
          }
          await tracePromise
        })

        it('can enable acquisition tracing between calls', async () => {
          tracer.use('oracledb', { poolAcquire: true })

          const result = await Promise.all([
            agent.assertFirstTraceSpan(expectedPoolAcquireSpan, {
              spanResourceMatch: /^oracle\.pool\.acquire$/,
            }),
            pool.getConnection(),
          ])
          await result[1].close()
        })
      })

      // oracledb has no stable JS-side queue across v5 thick / v6 thin, so the DBM tests below capture
      // the plugin-produced SQL via `apm:oracledb:query:start` instead of reading a driver-internal queue
      // (the pattern pg / mysql / mysql2 tests use).
      describe('with DBM propagation disabled (default)', () => {
        let injected
        const onStart = (ctx) => { injected = ctx.injected }

        before(async () => {
          tracer = await agent.load('oracledb')
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          dc.subscribe('apm:oracledb:query:start', onStart)
          connection = await oracledb.getConnection(config)
        })

        after(async () => {
          dc.unsubscribe('apm:oracledb:query:start', onStart)
          await connection.close()
          await agent.close()
        })

        beforeEach(() => {
          injected = undefined
        })

        it('should not inject a comment when propagation is disabled', async () => {
          await connection.execute(dbQuery)
          assert.strictEqual(injected, dbQuery)
        })
      })

      // When the legacy store handle is marked `noop` (the suppression mechanism used by the
      // agent's own request loop), the plugin's bindStart is skipped and ctx.injected stays
      // undefined; the instrumentation must not overwrite the caller's SQL with it.
      describe('with tracing suppressed via the noop legacy store handle', () => {
        before(async () => {
          tracer = await agent.load('oracledb')
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          connection = await oracledb.getConnection(config)
        })

        after(async () => {
          await connection.close()
          await agent.close()
        })

        it('passes the caller SQL through unchanged when bindStart is skipped', async () => {
          await storage('legacy').run({ noop: true }, () => connection.execute(dbQuery))
        })
      })

      describe('with DBM propagation enabled with service using plugin configurations', () => {
        let injected
        const onStart = (ctx) => { injected = ctx.injected }

        before(async () => {
          tracer = await agent.load('oracledb', { dbmPropagationMode: 'service', service: () => 'serviced' })
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          dc.subscribe('apm:oracledb:query:start', onStart)
          connection = await oracledb.getConnection(config)
        })

        after(async () => {
          dc.unsubscribe('apm:oracledb:query:start', onStart)
          await connection.close()
          await agent.close()
        })

        beforeEach(() => {
          injected = undefined
        })

        it('should contain comment in query text', async () => {
          await connection.execute(dbQuery)
          assert.strictEqual(
            injected,
            `/*dddb='${dbInstance}',dddbs='serviced',dde='tester',ddh='${hostname}',ddps='test',` +
            `ddpv='${ddpv}'*/ ${dbQuery}`
          )
        })

        it('should contain comment in query text for callback-form execute', done => {
          connection.execute(dbQuery, err => {
            if (err) return done(err)
            try {
              assert.strictEqual(
                injected,
                `/*dddb='${dbInstance}',dddbs='serviced',dde='tester',ddh='${hostname}',ddps='test',` +
                `ddpv='${ddpv}'*/ ${dbQuery}`
              )
              done()
            } catch (e) {
              done(e)
            }
          })
        })

        it('trace query resource should not be changed when propagation is enabled', async () => {
          await Promise.all([
            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].resource, dbQuery)
            }),
            connection.execute(dbQuery),
          ])
        })
      })

      // oracledb 6.4 added object-form execute (`{ statement, values }`) to support
      // sql-template-tag style usage. Earlier drivers reject the object outright at
      // argument validation, so the test only runs on >= 6.4.
      if (semver.intersects(version, '>=6.4.0')) {
        describe('with DBM propagation enabled and object-form execute', () => {
          let injected
          const onStart = (ctx) => { injected = ctx.injected }

          before(async () => {
            tracer = await agent.load('oracledb', { dbmPropagationMode: 'service', service: () => 'serviced' })
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            dc.subscribe('apm:oracledb:query:start', onStart)
            connection = await oracledb.getConnection(config)
          })

          after(async () => {
            dc.unsubscribe('apm:oracledb:query:start', onStart)
            await connection.close()
            await agent.close()
          })

          beforeEach(() => {
            injected = undefined
          })

          it('should inject comment into statement and preserve binds', async () => {
            await connection.execute({ statement: dbQuery, values: [] })
            assert.deepStrictEqual(injected, {
              statement:
                `/*dddb='${dbInstance}',dddbs='serviced',dde='tester',ddh='${hostname}',ddps='test',` +
                `ddpv='${ddpv}'*/ ${dbQuery}`,
              values: [],
            })
          })

          it('trace query resource should reflect the statement string', async () => {
            await Promise.all([
              agent.assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].resource, dbQuery)
              }),
              connection.execute({ statement: dbQuery, values: [] }),
            ])
          })
        })

        describe('with DBM propagation disabled and object-form execute', () => {
          let injected
          const onStart = (ctx) => { injected = ctx.injected }

          before(async () => {
            tracer = await agent.load('oracledb')
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            dc.subscribe('apm:oracledb:query:start', onStart)
            connection = await oracledb.getConnection(config)
          })

          after(async () => {
            dc.unsubscribe('apm:oracledb:query:start', onStart)
            await connection.close()
            await agent.close()
          })

          beforeEach(() => {
            injected = undefined
          })

          it('should pass through the original statement and binds unchanged', async () => {
            const query = { statement: dbQuery, values: [] }
            await connection.execute(query)
            assert.deepStrictEqual(injected, { statement: dbQuery, values: [] })
          })
        })
      }

      describe('DBM propagation should handle special characters', () => {
        let injected
        const onStart = (ctx) => { injected = ctx.injected }

        before(async () => {
          tracer = await agent.load('oracledb', { dbmPropagationMode: 'service', service: '~!@#$%^&*()_+|??/<>' })
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          dc.subscribe('apm:oracledb:query:start', onStart)
          connection = await oracledb.getConnection(config)
        })

        after(async () => {
          dc.unsubscribe('apm:oracledb:query:start', onStart)
          await connection.close()
          await agent.close()
        })

        beforeEach(() => {
          injected = undefined
        })

        it('DBM propagation should handle special characters', async () => {
          await connection.execute(dbQuery)
          assert.strictEqual(
            injected,
            `/*dddb='${dbInstance}',dddbs='~!%40%23%24%25%5E%26*()_%2B%7C%3F%3F%2F%3C%3E',dde='tester',` +
            `ddh='${hostname}',ddps='test',ddpv='${ddpv}'*/ ${dbQuery}`
          )
        })
      })

      describe('with DBM propagation enabled with full using tracer configurations', () => {
        let seenTraceParent
        let seenTraceId
        let seenSpanId
        const onStart = (ctx) => {
          const m = ctx.injected?.match(/traceparent='([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})'/)
          if (m) {
            seenTraceParent = true
            seenTraceId = m[2]
            seenSpanId = m[3]
          }
        }

        before(async () => {
          tracer = await agent.load('oracledb')
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          dc.subscribe('apm:oracledb:query:start', onStart)
          connection = await oracledb.getConnection(config)
        })

        after(async () => {
          dc.unsubscribe('apm:oracledb:query:start', onStart)
          await connection.close()
          await agent.close()
        })

        beforeEach(() => {
          tracer.use('oracledb', { dbmPropagationMode: 'full' })
          seenTraceParent = undefined
          seenTraceId = undefined
          seenSpanId = undefined
        })

        it('query text should contain traceparent', async () => {
          await Promise.all([
            agent.assertSomeTraces(traces => {
              const expectedTimePrefix = traces[0][0].meta['_dd.p.tid'].toString(16).padStart(16, '0')
              const traceId = expectedTimePrefix + traces[0][0].trace_id.toString(16).padStart(16, '0')
              const spanId = traces[0][0].span_id.toString(16).padStart(16, '0')
              assert.strictEqual(seenTraceParent, true)
              assert.strictEqual(seenTraceId, traceId)
              assert.strictEqual(seenSpanId, spanId)
            }),
            connection.execute(dbQuery),
          ])
        })

        it('query should inject _dd.dbm_trace_injected into span', async () => {
          await Promise.all([
            agent.assertSomeTraces(traces => {
              assertObjectContains(traces[0][0].meta, {
                '_dd.dbm_trace_injected': 'true',
              })
            }),
            connection.execute(dbQuery),
          ])
        })

        it('service should default to tracer service name', async () => {
          await Promise.all([
            agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].service, expectedSchema.outbound.serviceName)
            }),
            connection.execute(dbQuery),
          ])
        })
      })

      describe('with DBM propagation enabled with append comment configurations', () => {
        let injected
        const onStart = (ctx) => { injected = ctx.injected }

        before(async () => {
          tracer = await agent.load('oracledb', {
            appendComment: true,
            dbmPropagationMode: 'service',
            service: () => 'serviced',
          })
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          dc.subscribe('apm:oracledb:query:start', onStart)
          connection = await oracledb.getConnection(config)
        })

        after(async () => {
          dc.unsubscribe('apm:oracledb:query:start', onStart)
          await connection.close()
          await agent.close()
        })

        beforeEach(() => {
          injected = undefined
        })

        it('should append comment in query text', async () => {
          await connection.execute(dbQuery)
          assert.strictEqual(
            injected,
            `${dbQuery} /*dddb='${dbInstance}',dddbs='serviced',dde='tester',ddh='${hostname}',` +
            `ddps='test',ddpv='${ddpv}'*/`
          )
        })
      })
    })

    describe('with DBM propagation enabled with append comment using tracer configuration', () => {
      let injected
      const onStart = (ctx) => { injected = ctx.injected }

      before(async () => {
        tracer = await agent.load('oracledb', {
          appendComment: true,
          service: () => 'serviced',
        }, {
          dbmPropagationMode: 'service',
        })
        oracledb = require('../../../versions/oracledb').get()
        dc.subscribe('apm:oracledb:query:start', onStart)
        connection = await oracledb.getConnection(config)
      })

      after(async () => {
        dc.unsubscribe('apm:oracledb:query:start', onStart)
        await connection.close()
        await agent.close()
      })

      beforeEach(() => {
        injected = undefined
      })

      it('should append service mode comment in query text', async () => {
        await connection.execute(dbQuery)
        assert.strictEqual(
          injected,
          `${dbQuery} /*dddb='${dbInstance}',dddbs='serviced',dde='tester',ddh='${hostname}',` +
          `ddps='test',ddpv='${ddpv}'*/`
        )
      })
    })
  })
})
