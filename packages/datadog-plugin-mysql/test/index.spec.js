'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/integration-test-helpers')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

createIntegrationTestSuite('mysql', 'mysql', testSetup, {
  category: 'database'
}, (meta) => {
  const { agent, tracer, span } = meta

  describe('Connection.query() - query', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          "name": "mysql.query",
          "meta": {
            "span.kind": "client",
            "db.type": "mysql",
            "component": "mysql",
            "db.name": "db",
            "db.user": "root",
            "db.statement": "INSERT INTO users (name, email) VALUES (?, ?)"
          },
          "metrics": {
            "db.pid": Symbol.for('test.ANY_NUMBER')
          }
        }
      )

      // Execute operation via test setup
      await testSetup.query_connection()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          "name": "mysql.query",
          "meta": {
            "span.kind": "client",
            "error.type": Symbol.for('test.ANY_STRING'),
            "error.message": Symbol.for('test.ANY_STRING'),
            "error.stack": Symbol.for('test.ANY_STRING'),
            "db.type": "mysql",
            "component": "mysql",
            "db.name": "db",
            "db.user": "root",
            "db.statement": "SELECT * FROM nonexistent_table"
          },
          "metrics": {
            "db.pid": Symbol.for('test.ANY_NUMBER')
          },
          "error": 1
        }
      )

      // Execute operation with expectError flag
      try {
        await testSetup.query_connection({ expectError: true })
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Pool.query() - query', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          "name": "mysql.query",
          "meta": {
            "span.kind": "client",
            "db.type": "mysql",
            "component": "mysql",
            "db.name": "db",
            "db.user": "root",
            "db.statement": "INSERT INTO users (name, email) VALUES (?, ?)"
          }
        }
      )

      // Execute operation via test setup
      await testSetup.query_pool()

      return traceAssertion
    })

    it('should generate span with error tags (error path)', async () => {
      const traceAssertion = agent.assertFirstTraceSpan(
        {
          "name": "mysql.query",
          "meta": {
            "span.kind": "client",
            "error.type": Symbol.for('test.ANY_STRING'),
            "error.message": Symbol.for('test.ANY_STRING'),
            "error.stack": Symbol.for('test.ANY_STRING'),
            "db.type": "mysql",
            "component": "mysql",
            "db.name": "db",
            "db.user": "root",
            "db.statement": "SELECT * FROM nonexistent_table"
          },
          "metrics": {
            "db.pid": Symbol.for('test.ANY_NUMBER')
          },
          "error": 1
        }
      )

      // Execute operation with expectError flag
      try {
        await testSetup.query_pool({ expectError: true })
      } catch (err) {
        // Expected error
      }

      return traceAssertion
    })
  })

  describe('Connection.beginTransaction() - transaction', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        let span = null
        for (const trace of traces) {
          span = trace.find(s => s.name === 'mysql.beginTransaction')
          if (span) break
        }
        if (!span) throw new Error('No span named mysql.beginTransaction found')

        const assert = require('assert')
        assert.strictEqual(span.name, 'mysql.beginTransaction')
        assert.strictEqual(span.meta['span.kind'], 'client')
        assert.strictEqual(span.meta['db.type'], 'mysql')
        assert.strictEqual(span.meta['component'], 'mysql')
        assert.strictEqual(span.meta['db.name'], 'db')
        assert.strictEqual(span.meta['db.user'], 'root')
        assert(typeof span.metrics['db.pid'] === 'number', 'db.pid should be a number')
      })

      // Execute operation via test setup
      await testSetup.transaction_connection()

      return traceAssertion
    })
  })

  describe('Connection.commit() - commit', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        let span = null
        for (const trace of traces) {
          span = trace.find(s => s.name === 'mysql.commit')
          if (span) break
        }
        if (!span) throw new Error('No span named mysql.commit found')

        const assert = require('assert')
        assert.strictEqual(span.name, 'mysql.commit')
        assert.strictEqual(span.meta['span.kind'], 'client')
        assert.strictEqual(span.meta['db.type'], 'mysql')
        assert.strictEqual(span.meta['component'], 'mysql')
        assert.strictEqual(span.meta['db.name'], 'db')
        assert.strictEqual(span.meta['db.user'], 'root')
        assert(typeof span.metrics['db.pid'] === 'number', 'db.pid should be a number')
      })

      // Execute operation via test setup
      await testSetup.commit_connection()

      return traceAssertion
    })
  })

  describe('Connection.rollback() - rollback', () => {
    it('should generate span with correct tags (happy path)', async () => {
      const traceAssertion = agent.assertSomeTraces((traces) => {
        let span = null
        for (const trace of traces) {
          span = trace.find(s => s.name === 'mysql.rollback')
          if (span) break
        }
        if (!span) throw new Error('No span named mysql.rollback found')

        const assert = require('assert')
        assert.strictEqual(span.name, 'mysql.rollback')
        assert.strictEqual(span.meta['span.kind'], 'client')
        assert.strictEqual(span.meta['db.type'], 'mysql')
        assert.strictEqual(span.meta['component'], 'mysql')
        assert.strictEqual(span.meta['db.name'], 'db')
        assert.strictEqual(span.meta['db.user'], 'root')
        assert(typeof span.metrics['db.pid'] === 'number', 'db.pid should be a number')
      })

      // Execute operation via test setup
      await testSetup.rollback_connection()

      return traceAssertion
    })
  })
})
