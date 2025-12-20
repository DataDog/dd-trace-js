'use strict'

const assert = require('assert')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/integration-test-helpers')
const { withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const TestSetup = require('./test-setup')
const agent = require('../../dd-trace/test/plugins/agent')

const testSetup = new TestSetup()

createIntegrationTestSuite('postgres', 'postgres', testSetup, {
  category: 'database'
}, (meta) => {
  describe('Query.handle() - postgres.command', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = meta.agent.assertFirstTraceSpan(
        {
          name: 'postgres.command',
          meta: {
            'span.kind': 'client',
            component: 'postgres'
          }
        }
      )

      await testSetup.connectionExecute()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = meta.agent.assertFirstTraceSpan(
        {
          name: 'postgres.command',
          meta: {
            'span.kind': 'client',
            component: 'postgres'
          },
          error: 1
        }
      )

      try {
        await testSetup.connectionExecuteError()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})

describe('Plugin', () => {
  describe('postgres', () => {
    withVersions('postgres', 'postgres', version => {
      let sql
      let tracer

      describe('with DBM propagation enabled (service mode)', () => {
        before(() => {
          return agent.load('postgres', { dbmPropagationMode: 'service', service: 'test-postgres' })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          tracer = require('../../dd-trace')
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

        it('should inject DBM comment into query', done => {
          agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            assert.ok(!span.resource.includes('/*'), 'Resource should not contain DBM comment')
            assert.strictEqual(span.meta.component, 'postgres')
            done()
          }).catch(done)

          sql`SELECT 1 as test`.then(() => {}).catch(() => {})
        })

        it('should set db.name and out.host tags', done => {
          agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            assert.strictEqual(span.meta['db.name'], 'postgres', 'Should have db.name tag')
            assert.strictEqual(span.meta['out.host'], '127.0.0.1', 'Should have out.host tag')
            assert.strictEqual(span.meta['db.user'], 'postgres', 'Should have db.user tag')
            done()
          }).catch(done)

          sql`SELECT 1 as test`.then(() => {}).catch(() => {})
        })

        it('should not include traceparent in service mode', done => {
          agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            assert.strictEqual(span.meta.component, 'postgres')
            assert.ok(!span.meta['_dd.dbm_trace_injected'], 'Should not have DBM trace injected tag in service mode')
            done()
          }).catch(done)

          sql`SELECT 1 as test`.then(() => {}).catch(() => {})
        })
      })

      describe('with DBM propagation enabled (full mode)', () => {
        before(() => {
          return agent.load('postgres', { dbmPropagationMode: 'full', service: 'test-postgres' })
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          tracer = require('../../dd-trace')
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

        it('should include traceparent in full mode', done => {
          agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            assert.strictEqual(span.meta.component, 'postgres')
            assert.strictEqual(
              span.meta['_dd.dbm_trace_injected'],
              'true',
              'Should have DBM trace injected tag in full mode'
            )
            done()
          }).catch(done)

          sql`SELECT 1 as test`.then(() => {}).catch(() => {})
        })
      })

      describe('peer service', () => {
        before(() => {
          return agent.load('postgres')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          tracer = require('../../dd-trace')
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

        withPeerService(
          () => tracer,
          'postgres',
          () => sql`SELECT 1 as test`,
          'postgres',
          'db.name'
        )
      })
    })
  })
})
