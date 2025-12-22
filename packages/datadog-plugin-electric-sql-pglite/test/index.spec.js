'use strict'

const sinon = require('sinon')
const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/integration-test-helpers')
const TestSetup = require('./test-setup')

// Use Symbol.for to get the global symbol from integration-tests/helpers
const ANY_STRING = Symbol.for('test.ANY_STRING')

const testSetup = new TestSetup()

createIntegrationTestSuite('electric-sql-pglite', '@electric-sql/pglite', testSetup, {
  category: 'database'
}, (meta) => {
  const { agent } = meta
  // Get tracer directly to access _pluginManager
  const getTracer = () => require('../../dd-trace')

  describe('BasePGlite.query() - postgres.query', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'electric-sql-pglite.query',
          meta: {
            'span.kind': 'client',
            'db.type': 'postgres',
            'db.name': 'postgres',
            'db.statement': ANY_STRING,
            component: 'electric-sql-pglite'
          },
          metrics: {}
        }
      )

      await testSetup.basePgliteQuery()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'electric-sql-pglite.query',
          meta: {
            'span.kind': 'client',
            'error.type': 'Error',
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
            'db.type': 'postgres',
            'db.name': 'postgres',
            'db.statement': ANY_STRING,
            component: 'electric-sql-pglite'
          },
          metrics: {},
          error: 1
        }
      )

      await testSetup.basePgliteQueryError()

      return traceAssertion
    })
  })

  describe('BasePGlite.exec() - postgres.exec', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'electric-sql-pglite.exec',
          meta: {
            'span.kind': 'client',
            'db.type': 'postgres',
            'db.name': 'postgres',
            'db.statement': ANY_STRING,
            component: 'electric-sql-pglite'
          },
          metrics: {}
        }
      )

      await testSetup.basePgliteExec()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'electric-sql-pglite.exec',
          meta: {
            'span.kind': 'client',
            'error.type': 'Error',
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
            'db.type': 'postgres',
            'db.name': 'postgres',
            'db.statement': ANY_STRING,
            component: 'electric-sql-pglite'
          },
          metrics: {},
          error: 1
        }
      )

      await testSetup.basePgliteExecError()

      return traceAssertion
    })
  })

  describe('BasePGlite.transaction() - postgres.transaction', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'electric-sql-pglite.transaction',
          meta: {
            'span.kind': 'client',
            'db.type': 'postgres',
            'db.name': 'postgres',
            'db.statement': ANY_STRING,
            component: 'electric-sql-pglite'
          },
          metrics: {}
        }
      )

      await testSetup.basePgliteTransaction()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'electric-sql-pglite.transaction',
          meta: {
            'span.kind': 'client',
            'error.type': 'Error',
            'error.message': ANY_STRING,
            'error.stack': ANY_STRING,
            'db.type': 'postgres',
            'db.name': 'postgres',
            component: 'electric-sql-pglite'
          },
          metrics: {},
          error: 1
        }
      )

      await testSetup.basePgliteTransactionError()

      return traceAssertion
    })
  })

  describe('peer service', () => {
    let computePeerServiceSpy

    beforeEach(() => {
      const tracer = getTracer()
      const plugin = tracer._pluginManager._pluginsByName['electric-sql-pglite']
      computePeerServiceSpy = sinon.stub(plugin._tracerConfig, 'spanComputePeerService').value(true)
    })

    afterEach(() => {
      computePeerServiceSpy.restore()
    })

    it('should compute peer service from db.name', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'electric-sql-pglite.query',
          meta: {
            'peer.service': 'postgres',
            '_dd.peer.service.source': 'db.name'
          }
        }
      )

      await testSetup.basePgliteQuery()

      return traceAssertion
    })
  })

  describe('DBM propagation', () => {
    describe('service mode', () => {
      beforeEach(() => {
        getTracer().use('electric-sql-pglite', { dbmPropagationMode: 'service' })
      })

      afterEach(() => {
        getTracer().use('electric-sql-pglite', { dbmPropagationMode: 'disabled' })
      })

      it('should not modify span resource when DBM is enabled', async () => {
        const traceAssertion = agent.assertFirstTraceSpan(
          {
            name: 'electric-sql-pglite.query',
            resource: ANY_STRING,
            meta: {
              'span.kind': 'client',
              'db.type': 'postgres',
              component: 'electric-sql-pglite'
            }
          }
        )

        await testSetup.basePgliteQuery()

        return traceAssertion
      })
    })

    describe('full mode', () => {
      beforeEach(() => {
        getTracer().use('electric-sql-pglite', { dbmPropagationMode: 'full' })
      })

      afterEach(() => {
        getTracer().use('electric-sql-pglite', { dbmPropagationMode: 'disabled' })
      })

      it('should inject _dd.dbm_trace_injected tag in full mode', async () => {
        const traceAssertion = agent.assertFirstTraceSpan(
          {
            name: 'electric-sql-pglite.query',
            meta: {
              'span.kind': 'client',
              'db.type': 'postgres',
              component: 'electric-sql-pglite',
              '_dd.dbm_trace_injected': 'true'
            }
          }
        )

        await testSetup.basePgliteQuery()

        return traceAssertion
      })

      it('should not modify span resource in full mode', async () => {
        const traceAssertion = agent.assertFirstTraceSpan(
          {
            name: 'electric-sql-pglite.query',
            resource: ANY_STRING,
            meta: {
              'span.kind': 'client',
              'db.type': 'postgres',
              component: 'electric-sql-pglite'
            }
          }
        )

        await testSetup.basePgliteQuery()

        return traceAssertion
      })
    })
  })
})
