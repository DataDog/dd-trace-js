'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/integration-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('neo4j-driver', 'neo4j-driver', testSetup, {
  category: 'database'
}, (meta) => {
  const { agent, tracer, span } = meta

  describe('Session.run() - query', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'neo4j-driver.run',
          meta: {
            'span.kind': 'client',
            'db.type': 'neo4j',
            component: 'neo4j-driver',
            'db.statement': Symbol.for('test.ANY_STRING')
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.session_run()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'neo4j-driver.run',
          meta: {
            'span.kind': 'client',
            'error.type': Symbol.for('test.ANY_STRING'),
            'error.message': Symbol.for('test.ANY_STRING'),
            'error.stack': Symbol.for('test.ANY_STRING'),
            'db.type': 'neo4j',
            component: 'neo4j-driver',
            'db.statement': Symbol.for('test.ANY_STRING')
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.session_run_error()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Transaction.run() - query', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'neo4j-driver.run',
          meta: {
            'span.kind': 'client',
            'db.type': 'neo4j',
            component: 'neo4j-driver',
            'db.statement': Symbol.for('test.ANY_STRING')
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.transaction_run()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'neo4j-driver.run',
          meta: {
            'span.kind': 'client',
            'error.type': Symbol.for('test.ANY_STRING'),
            'error.message': Symbol.for('test.ANY_STRING'),
            'error.stack': Symbol.for('test.ANY_STRING'),
            'db.type': 'neo4j',
            component: 'neo4j-driver',
            'db.statement': Symbol.for('test.ANY_STRING')
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.transaction_run_error()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Session.executeRead() - transaction', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'neo4j-driver.executeRead',
          meta: {
            'span.kind': 'client',
            'db.type': Symbol.for('test.ANY_STRING'),
            component: 'neo4j-driver',
            'db.name': Symbol.for('test.ANY_STRING'),
            'db.user': Symbol.for('test.ANY_STRING'),
            'db.statement': Symbol.for('test.ANY_STRING'),
            'db.stream': Symbol.for('test.ANY_STRING')
          },
          metrics: {
            'db.pid': Symbol.for('test.ANY_NUMBER')
          }
        }
      )

      // Execute operation via test setup
      await testSetup.session_executeread()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'neo4j-driver.executeRead',
          meta: {
            'span.kind': 'client',
            'error.type': Symbol.for('test.ANY_STRING'),
            'error.message': Symbol.for('test.ANY_STRING'),
            'error.stack': Symbol.for('test.ANY_STRING'),
            'db.type': Symbol.for('test.ANY_STRING'),
            component: 'neo4j-driver',
            'db.name': Symbol.for('test.ANY_STRING'),
            'db.user': Symbol.for('test.ANY_STRING'),
            'db.statement': Symbol.for('test.ANY_STRING'),
            'db.stream': Symbol.for('test.ANY_STRING')
          },
          metrics: {
            'db.pid': Symbol.for('test.ANY_NUMBER')
          },
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.session_executeread_error()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Session.executeWrite() - transaction', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'neo4j-driver.executeWrite',
          meta: {
            'span.kind': 'client',
            component: 'neo4j-driver',
            'db.type': Symbol.for('test.ANY_STRING'),
            'db.statement': Symbol.for('test.ANY_STRING')
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.session_executewrite()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'neo4j-driver.executeWrite',
          meta: {
            'span.kind': 'client',
            'error.type': Symbol.for('test.ANY_STRING'),
            'error.message': Symbol.for('test.ANY_STRING'),
            'error.stack': Symbol.for('test.ANY_STRING'),
            component: 'neo4j-driver',
            'db.type': Symbol.for('test.ANY_STRING'),
            'db.statement': Symbol.for('test.ANY_STRING')
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.session_executewrite_error()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Transaction.commit() - commit', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'neo4j-driver.commit',
          meta: {
            'span.kind': 'client',
            'db.type': 'neo4j',
            component: 'neo4j-driver'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.transaction_commit()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'neo4j-driver.commit',
          meta: {
            'span.kind': 'client',
            'error.type': Symbol.for('test.ANY_STRING'),
            'error.message': Symbol.for('test.ANY_STRING'),
            'error.stack': Symbol.for('test.ANY_STRING'),
            'db.type': 'neo4j',
            component: 'neo4j-driver'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.transaction_commit_error()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Transaction.rollback() - rollback', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'neo4j-driver.rollback',
          meta: {
            'span.kind': 'client',
            'db.type': 'neo4j',
            component: 'neo4j-driver'
          },
          metrics: {}
        }
      )

      // Execute operation via test setup
      await testSetup.transaction_rollback()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          name: 'neo4j-driver.rollback',
          meta: {
            'span.kind': 'client',
            'error.type': Symbol.for('test.ANY_STRING'),
            'error.message': Symbol.for('test.ANY_STRING'),
            'error.stack': Symbol.for('test.ANY_STRING'),
            'db.type': 'neo4j',
            component: 'neo4j-driver'
          },
          metrics: {},
          error: 1
        }
      )

      // Execute operation error variant
      try {
        await testSetup.transaction_rollback_error()
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })
})
