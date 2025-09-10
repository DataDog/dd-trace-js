'use strict'

const { expect } = require('chai')
const { it } = require('mocha')
const agent = require('../../../../plugins/agent')
const { createTestSuite } = require('../base-test-scaffolder')

// Base integration test helper (legacy class-based approach)
class IntegrationTestHelper {
  constructor (pluginName, packageName, TestSetupClass, options = {}) {
    this.pluginName = pluginName
    this.packageName = packageName
    this.TestSetupClass = TestSetupClass
    this.options = {
      skipVersions: options.skipVersions || false,
      additionalPlugins: options.additionalPlugins || [],
      pluginConfig: options.pluginConfig || {},
      testAgentOptions: options.testAgentOptions || { host: 'localhost', port: 8126 },
      ...options
    }
  }

  createTestSuite () {
    createTestSuite(this.pluginName, this.packageName, this.TestSetupClass, (helper) => {
      this.generateTestCases(helper)
    }, this.options)
  }

  generateTestCases (helper) {
    it('should load the module correctly', () => {
      expect(helper.mod).to.be.an('object')
      expect(helper.testSetup).to.be.an('object')
    })

    it('should create spans for instrumented operations', (done) => {
      if (!helper.testSetup.performBasicOperation) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces).to.have.length.greaterThan(0)
          expect(traces[0]).to.have.length.greaterThan(0)
          expect(traces[0][0]).to.have.property('name')
          expect(traces[0][0]).to.have.property('service', 'test')
          expect(traces[0][0].meta).to.have.property('component')
        })
        .then(done)
        .catch(done)

      helper.testSetup.performBasicOperation().catch(done)
    })
  }
}

module.exports = { IntegrationTestHelper }
