'use strict'

const assert = require('node:assert')

const dc = require('dc-polyfill')
const { after, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const ddpv = require('mocha/package.json').version
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
            connection = await pool.getConnection()
          })

          after(async () => {
            await connection.close()
            await pool.close()
          })

          poolTests()

          withPeerService(
            () => tracer,
            'oracledb',
            () => connection.execute(dbQuery),
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
            connection = await pool.getConnection()
          })

          after(async () => {
            await connection.close()
            await pool.close()
          })

          poolTests()
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
                return connAttrs.connectString
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
        })

        describe('with connectionString fallback', () => {
          before(async () => {
            await agent.load('oracledb', {
              service: connAttrs => connAttrs.connectString || connAttrs.connectionString,
            })
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            tracer = require('../../dd-trace')
          })

          after(async () => {
            await agent.close()
          })

          it('should fallback to connectionString when connectString is not available', async () => {
            const connection = await oracledb.getConnection({
              user: config.user,
              password: config.password,
              connectionString: config.connectString, // Use valid connection string
            })

            await Promise.all([
              agent.assertFirstTraceSpan({
                service: config.connectString,
              }),
              connection.execute(dbQuery),
            ])
            await connection.close()
          })
        })
      })

      // oracledb has no stable JS-side queue across v5 thick / v6 thin, so the DBM tests below capture
      // the plugin-produced SQL via `apm:oracledb:query:start` instead of reading a driver-internal queue
      // (the pattern pg / mysql / mysql2 tests use).
      describe('with DBM propagation disabled (default)', () => {
        let injected
        const onStart = (ctx) => { injected = ctx.injected }

        before(async () => {
          await agent.load('oracledb')
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          tracer = require('../../dd-trace')
          dc.subscribe('apm:oracledb:query:start', onStart)
          connection = await oracledb.getConnection(config)
        })

        after(async () => {
          dc.unsubscribe('apm:oracledb:query:start', onStart)
          await connection.close()
          await agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          injected = undefined
        })

        it('should not inject a comment when propagation is disabled', async () => {
          await connection.execute(dbQuery)
          assert.strictEqual(injected, dbQuery)
        })
      })

      describe('with DBM propagation enabled with service using plugin configurations', () => {
        let injected
        const onStart = (ctx) => { injected = ctx.injected }

        before(async () => {
          await agent.load('oracledb', { dbmPropagationMode: 'service', service: () => 'serviced' })
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          tracer = require('../../dd-trace')
          dc.subscribe('apm:oracledb:query:start', onStart)
          connection = await oracledb.getConnection(config)
        })

        after(async () => {
          dc.unsubscribe('apm:oracledb:query:start', onStart)
          await connection.close()
          await agent.close({ ritmReset: false })
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
            await agent.load('oracledb', { dbmPropagationMode: 'service', service: () => 'serviced' })
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            tracer = require('../../dd-trace')
            dc.subscribe('apm:oracledb:query:start', onStart)
            connection = await oracledb.getConnection(config)
          })

          after(async () => {
            dc.unsubscribe('apm:oracledb:query:start', onStart)
            await connection.close()
            await agent.close({ ritmReset: false })
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
            await agent.load('oracledb')
            oracledb = require(`../../../versions/oracledb@${version}`).get()
            tracer = require('../../dd-trace')
            dc.subscribe('apm:oracledb:query:start', onStart)
            connection = await oracledb.getConnection(config)
          })

          after(async () => {
            dc.unsubscribe('apm:oracledb:query:start', onStart)
            await connection.close()
            await agent.close({ ritmReset: false })
          })

          beforeEach(() => {
            injected = undefined
          })

          it('should pass through the original object without allocating a new one', async () => {
            const query = { statement: dbQuery, values: [] }
            await connection.execute(query)
            assert.strictEqual(injected, query)
          })
        })
      }

      describe('DBM propagation should handle special characters', () => {
        let injected
        const onStart = (ctx) => { injected = ctx.injected }

        before(async () => {
          await agent.load('oracledb', { dbmPropagationMode: 'service', service: '~!@#$%^&*()_+|??/<>' })
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          tracer = require('../../dd-trace')
          dc.subscribe('apm:oracledb:query:start', onStart)
          connection = await oracledb.getConnection(config)
        })

        after(async () => {
          dc.unsubscribe('apm:oracledb:query:start', onStart)
          await connection.close()
          await agent.close({ ritmReset: false })
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
          await agent.load('oracledb')
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          tracer = require('../../dd-trace')
          dc.subscribe('apm:oracledb:query:start', onStart)
          connection = await oracledb.getConnection(config)
        })

        after(async () => {
          dc.unsubscribe('apm:oracledb:query:start', onStart)
          await connection.close()
          await agent.close({ ritmReset: false })
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
          await agent.load('oracledb', {
            appendComment: true,
            dbmPropagationMode: 'service',
            service: () => 'serviced',
          })
          oracledb = require(`../../../versions/oracledb@${version}`).get()
          tracer = require('../../dd-trace')
          dc.subscribe('apm:oracledb:query:start', onStart)
          connection = await oracledb.getConnection(config)
        })

        after(async () => {
          dc.unsubscribe('apm:oracledb:query:start', onStart)
          await connection.close()
          await agent.close({ ritmReset: false })
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

    // Lives outside `withVersions` so the global-tracer wipe needed to test
    // tracer-level config (third `agent.load` arg) does not strand sibling
    // describe blocks in the next oracledb-version iteration.
    describe('with DBM propagation enabled with append comment using tracer configuration', () => {
      let injected
      const onStart = (ctx) => { injected = ctx.injected }

      before(async () => {
        // Tracer-level config (third arg) only takes effect if the global
        // tracer is wiped first; tracer.init() short-circuits once the
        // process-wide singleton has been initialized by an earlier load.
        agent.wipe()
        await agent.load('oracledb', {
          appendComment: true,
          service: () => 'serviced',
        }, {
          dbmPropagationMode: 'service',
        })
        oracledb = require('../../../versions/oracledb').get()
        tracer = require('../../dd-trace')
        dc.subscribe('apm:oracledb:query:start', onStart)
        connection = await oracledb.getConnection(config)
      })

      after(async () => {
        dc.unsubscribe('apm:oracledb:query:start', onStart)
        await connection.close()
        await agent.close({ ritmReset: false, wipe: true })
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
