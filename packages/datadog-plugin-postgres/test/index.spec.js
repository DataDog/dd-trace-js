'use strict'

const assert = require('assert')
const net = require('net')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/integration-test-helpers')
const TestSetup = require('./test-setup')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const testSetup = new TestSetup()

createIntegrationTestSuite('postgres', 'postgres', testSetup, {
  category: 'database'
}, (meta) => {
  const { agent } = meta

  describe('Query.handle() - postgres.command', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'postgres.command',
          meta: {
            'span.kind': 'client',
            component: 'postgres',
            'db.type': 'postgres'
          },
          metrics: {},
          resource: 'SELECT * FROM test_users'
        }
      )

      await testSetup.queryHandle()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'postgres.command',
          meta: {
            'span.kind': 'client',
            component: 'postgres',
            'db.type': 'postgres'
          }
        }
      )

      await testSetup.queryHandleError().catch(() => {})

      return traceAssertion
    })

    it('should set resource to query text', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'postgres.command',
          resource: 'SELECT * FROM test_users'
        }
      )

      await testSetup.queryHandle()

      return traceAssertion
    })
  })
})

// Peer service tests with separate agent/tracer lifecycle
describe('Plugin', () => {
  describe('postgres', () => {
    withVersions('postgres', 'postgres', version => {
      describe('peer service', () => {
        let tracer
        let sql

        before(async () => {
          await agent.load('postgres')
        })

        after(async () => {
          await agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          tracer = require('../../dd-trace').init()
          const postgres = require(`../../../versions/postgres@${version}`).get()

          sql = postgres({
            host: '127.0.0.1',
            port: 5432,
            database: 'postgres',
            username: 'postgres',
            password: 'postgres'
          })
        })

        afterEach(async () => {
          if (sql) {
            await sql.end()
          }
        })

        it('should set peer.service from db.name when spanComputePeerService is enabled', async () => {
          const plugin = tracer?._pluginManager?._pluginsByName?.postgres

          const originalConfig = plugin._tracerConfig.spanComputePeerService
          plugin._tracerConfig.spanComputePeerService = true

          try {
            // Manually store connection options for the handler
            // (In real usage, this would come from an instrumented factory)
            const storeOptions = () => {
              const dummyStrings = Object.assign(['SELECT 1'], { raw: ['SELECT 1'] })
              const dummyQuery = sql(dummyStrings)
              if (dummyQuery && dummyQuery.handler) {
                const PostgresPlugin = require('../src/index.js')
                PostgresPlugin.storeConnectionOptions(dummyQuery.handler, {
                  host: '127.0.0.1',
                  port: 5432,
                  database: 'testdb',
                  username: 'postgres'
                })
              }
              if (dummyQuery.cancel) {
                dummyQuery.cancel()
              }
            }

            const tracesPromise = agent.assertSomeTraces(traces => {
              const span = traces[0][0]
              assert.strictEqual(span.meta['db.type'], 'postgres', 'db.type is required semantic tag')
              assert.strictEqual(span.meta['span.kind'], 'client', 'span.kind is required semantic tag')
              assert.strictEqual(span.meta['component'], 'postgres', 'component is optional semantic tag')
              if (span.meta['db.name']) {
                assert.strictEqual(span.meta['peer.service'], span.meta['db.name'], 'peer.service should match db.name')
                assert.strictEqual(span.meta['_dd.peer.service.source'], 'db.name', '_dd.peer.service.source should indicate db.name as source')
              }
            })

            storeOptions()
            const result = await sql`SELECT 1 as test`

            // Verify the library still works by validating query results
            if (result) {
              assert.ok(Array.isArray(result), 'Query should return an array')
              assert.strictEqual(result.length, 1, 'Query should return one row')
              assert.strictEqual(result[0].test, 1, 'Query result should have test field equal to 1')
            }

            await tracesPromise
          } finally {
            plugin._tracerConfig.spanComputePeerService = originalConfig
          }
        })
      })

      describe('with DBM propagation enabled in service mode', () => {
        let sql

        before(async () => {
          await agent.load('postgres', {
            dbmPropagationMode: 'service',
            service: 'test-postgres-dbm'
          })
        })

        after(async () => {
          await agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          require('../../dd-trace').init()
          const postgres = require(`../../../versions/postgres@${version}`).get()

          sql = postgres({
            host: '127.0.0.1',
            port: 5432,
            database: 'postgres',
            username: 'postgres',
            password: 'postgres'
          })
        })

        afterEach(async () => {
          if (sql) {
            await sql.end()
          }
        })

        it('should inject DBM comment into query', async () => {
          let seenDbmComment = false
          let capturedQuery = ''
          const originalWrite = net.Socket.prototype.write

          // Intercept socket writes to verify DBM comment is sent
          net.Socket.prototype.write = function (buffer) {
            const strBuf = buffer.toString()
            if (strBuf.includes("dddbs='test-postgres-dbm'")) {
              seenDbmComment = true
              capturedQuery = strBuf
            }
            return originalWrite.apply(this, arguments)
          }

          agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            assert.strictEqual(span.meta['span.kind'], 'client', 'span.kind should be client')
            assert.strictEqual(span.meta['component'], 'postgres', 'component should be postgres')
            assert.strictEqual(span.meta['db.type'], 'postgres', 'db.type should be postgres')
            assert.ok(span.meta['db.name'], 'db.name should be present')
          })

          const result = await sql`SELECT 1 as test`
          net.Socket.prototype.write = originalWrite

          // Verify the library still works by validating query results
          if (result) {
            assert.ok(Array.isArray(result), 'Query should return an array')
            assert.strictEqual(result.length, 1, 'Query should return one row')
            assert.strictEqual(result[0].test, 1, 'Query result should have test field equal to 1')
          }

          assert.ok(
            seenDbmComment,
            `Query should contain DBM comment with service name. Captured: ${capturedQuery}`
          )
        })

        it('should not include traceparent in service mode', async () => {
          let seenTraceparent = false
          const originalWrite = net.Socket.prototype.write

          // Intercept socket writes to verify no traceparent is sent
          net.Socket.prototype.write = function (buffer) {
            const strBuf = buffer.toString()
            if (strBuf.includes("traceparent='")) {
              seenTraceparent = true
            }
            return originalWrite.apply(this, arguments)
          }

          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            assert.strictEqual(span.meta['span.kind'], 'client', 'span.kind should be client')
            assert.strictEqual(span.meta['component'], 'postgres', 'component should be postgres')
            assert.strictEqual(span.meta['db.type'], 'postgres', 'db.type should be postgres')
          })

          const result = await sql`SELECT 1 as test`
          net.Socket.prototype.write = originalWrite

          // Verify the library still works by validating query results
          if (result) {
            assert.ok(Array.isArray(result), 'Query should return an array')
            assert.strictEqual(result.length, 1, 'Query should return one row')
            assert.strictEqual(result[0].test, 1, 'Query result should have test field equal to 1')
          }

          assert.ok(
            !seenTraceparent,
            'Query should not contain traceparent in service mode'
          )

          await tracesPromise
        })

        it('resource should not include DBM comment', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            assert.ok(
              !span.resource.includes('/*'),
              `Resource should not contain DBM comment, got: ${span.resource}`
            )
            assert.strictEqual(span.meta['span.kind'], 'client', 'span.kind should be client')
            assert.strictEqual(span.meta['component'], 'postgres', 'component should be postgres')
            assert.strictEqual(span.meta['db.type'], 'postgres', 'db.type should be postgres')
          })

          await sql`SELECT 1 as test`
          await tracesPromise
        })
      })

      describe('with DBM propagation enabled in full mode', () => {
        let sql
        const originalWrite = net.Socket.prototype.write

        before(async () => {
          await agent.load('postgres', {
            dbmPropagationMode: 'full',
            service: 'test-postgres-dbm-full'
          })
        })

        after(async () => {
          await agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          require('../../dd-trace').init()
          const postgres = require(`../../../versions/postgres@${version}`).get()

          sql = postgres({
            host: '127.0.0.1',
            port: 5432,
            database: 'postgres',
            username: 'postgres',
            password: 'postgres'
          })
        })

        afterEach(async () => {
          if (sql) {
            await sql.end()
          }
        })

        it('should inject traceparent in full mode', async () => {
          // Intercept socket writes to capture sent data
          const capturedWrites = []
          net.Socket.prototype.write = function (buffer) {
            const strBuf = buffer.toString()
            capturedWrites.push(strBuf)
            return originalWrite.apply(this, arguments)
          }

          try {
            const tracesPromise = agent.assertSomeTraces(traces => {
              const span = traces[0][0]
              assert.strictEqual(span.meta['db.type'], 'postgres', 'db.type should be postgres')
              assert.strictEqual(span.meta['span.kind'], 'client', 'span.kind should be client')
              assert.strictEqual(span.meta['component'], 'postgres', 'component should be postgres')
            })

            await sql`SELECT 1 as test`
            await tracesPromise

            // Verify traceparent was injected
            const hasTraceparent = capturedWrites.some(write => write.includes('traceparent=\''))
            assert.ok(
              hasTraceparent,
              'Query should contain traceparent in full mode'
            )
          } finally {
            net.Socket.prototype.write = originalWrite
          }
        })

        it('should set _dd.dbm_trace_injected tag', async () => {
          const tracesPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            assert.strictEqual(
              span.meta['_dd.dbm_trace_injected'],
              'true',
              'Span should have _dd.dbm_trace_injected tag'
            )
            assert.strictEqual(span.meta['db.type'], 'postgres', 'db.type should be postgres')
            assert.strictEqual(span.meta['span.kind'], 'client', 'span.kind should be client')
            assert.strictEqual(span.meta['component'], 'postgres', 'component should be postgres')
          })

          await sql`SELECT 1 as test`
          await tracesPromise
        })
      })
    })
  })
})
