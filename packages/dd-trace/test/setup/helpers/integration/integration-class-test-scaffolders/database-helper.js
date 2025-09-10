'use strict'

const { it } = require('mocha')
const { expect } = require('chai')
const agent = require('../../../../plugins/agent')
const { IntegrationTestHelper } = require('./base-integration-helper')

// Database test helper for Redis, MySQL, MongoDB, etc.
class DatabaseTestHelper extends IntegrationTestHelper {
  validateTestSetup (testSetup, pluginName) {
    const required = ['performRead', 'performWrite']
    const missing = required.filter(method => typeof testSetup[method] !== 'function')
    if (missing.length > 0) {
      throw new Error(`${pluginName} test setup missing: ${missing.join(', ')}`)
    }
  }

  generateTestCases (helper) {
    super.generateTestCases(helper)

    it('should instrument database read operations', (done) => {
      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', helper.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'client')
          expect(traces[0][0].meta).to.have.property('db.type')
        })
        .then(done)
        .catch(done)

      helper.testSetup.performRead().catch(done)
    })

    it('should instrument database write operations', (done) => {
      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', helper.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'client')
        })
        .then(done)
        .catch(done)

      helper.testSetup.performWrite().catch(done)
    })

    it('should instrument database query operations', (done) => {
      if (!helper.testSetup.performQuery) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', helper.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'client')
        })
        .then(done)
        .catch(done)

      helper.testSetup.performQuery().catch(done)
    })

    it('should instrument database transaction operations', (done) => {
      if (!helper.testSetup.performTransaction) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', helper.pluginName)
        })
        .then(done)
        .catch(done)

      helper.testSetup.performTransaction().catch(done)
    })
  }
}

module.exports = { DatabaseTestHelper }
