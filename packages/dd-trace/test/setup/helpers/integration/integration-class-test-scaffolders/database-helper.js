'use strict'

const { it } = require('mocha')
const { expect } = require('chai')
const agent = require('../../../../plugins/agent')
const { BaseTestHelper } = require('./base-helper')

// Database test helper for Redis, MySQL, MongoDB, etc.
class DatabaseTestHelper extends BaseTestHelper {
  static get operations () {
    return {
      required: [
        'performRead',
        'performReadError',
        'performWrite',
        'performWriteError'
      ],
      optional: [
        'performQuery',
        'performQueryError',
        'performTransaction',
        'performTransactionError'
      ]
    }
  }

  validateTestSetup (testSetup, pluginName) {
    const required = ['performRead', 'performWrite']
    const missing = required.filter(method => typeof testSetup[method] !== 'function')
    if (missing.length > 0) {
      throw new Error(`${pluginName} test setup missing: ${missing.join(', ')}`)
    }
  }

  generateTestCases () {
    super.generateTestCases()

    it('should instrument database read operations', (done) => {
      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', this.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'client')
          expect(traces[0][0].meta).to.have.property('db.type')
        })
        .then(done)
        .catch(done)

      this.testSetup.performRead().catch(done)
    })

    it('should instrument database write operations', (done) => {
      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', this.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'client')
        })
        .then(done)
        .catch(done)

      this.testSetup.performWrite().catch(done)
    })

    it('should instrument database query operations', (done) => {
      if (!this.testSetup.performQuery) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', this.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'client')
        })
        .then(done)
        .catch(done)

      this.testSetup.performQuery().catch(done)
    })

    it('should instrument database transaction operations', (done) => {
      if (!this.testSetup.performTransaction) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', this.pluginName)
        })
        .then(done)
        .catch(done)

      this.testSetup.performTransaction().catch(done)
    })

    it('should handle errors in database operations', (done) => {
      if (!this.testSetup.performReadError) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.have.property('error', 1)
          expect(traces[0][0].meta).to.have.property('component', this.pluginName)
        })
        .then(done)
        .catch(done)

      this.testSetup.performReadError().catch(() => {})
    })

    it('should handle write errors', (done) => {
      if (!this.testSetup.performWriteError) return done()
      agent.assertSomeTraces(traces => {
        expect(traces[0][0]).to.have.property('error', 1)
      }).then(done).catch(done)
      this.testSetup.performWriteError().catch(() => {})
    })

    it('should handle query errors', (done) => {
      if (!this.testSetup.performQueryError) return done()
      agent.assertSomeTraces(traces => {
        expect(traces[0][0]).to.have.property('error', 1)
      }).then(done).catch(done)
      this.testSetup.performQueryError().catch(() => {})
    })

    it('should handle transaction errors', (done) => {
      if (!this.testSetup.performTransactionError) return done()
      agent.assertSomeTraces(traces => {
        expect(traces[0][0]).to.have.property('error', 1)
      }).then(done).catch(done)
      this.testSetup.performTransactionError().catch(() => {})
    })
  }
}

module.exports = { DatabaseTestHelper }
