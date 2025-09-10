'use strict'

/**
 * Integration Test Helper Template
 * This gets copied to packages/dd-trace/test/setup/integration-test-helper.js
 * and provides the boilerplate for all integration tests
 */

function generateIntegrationTestHelper () {
  return `'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const agent = require('../plugins/agent')
const { withVersions } = require('./mocha')

/**
 * Integration Test Helper
 * Handles all the boilerplate setup that's common across integration tests
 * 
 * Usage:
 *   const { IntegrationTestHelper } = require('../../dd-trace/test/setup/integration-test-helper')
 *   const { MyTestSetup } = require('./scenarios/my-test-setup')
 *   
 *   const testHelper = new IntegrationTestHelper('myPlugin', 'my-package', MyTestSetup)
 *   testHelper.createTestSuite()
 */
class IntegrationTestHelper {
  constructor (pluginName, packageName, TestSetupClass, options = {}) {
    this.pluginName = pluginName
    this.packageName = packageName
    this.TestSetupClass = TestSetupClass
    this.options = {
      skipVersions: options.skipVersions || false,
      additionalPlugins: options.additionalPlugins || [],
      pluginConfig: options.pluginConfig || {},
      ...options
    }
    
    this.testSetup = null
    this.mod = null
    this.tracer = null
  }

  /**
   * Create the standard test structure with all the boilerplate
   */
  createTestSuite () {
    describe('Plugin', () => {
      describe(this.pluginName, () => {
        if (this.options.skipVersions) {
          this.createSingleVersionTests()
        } else {
          withVersions(this.pluginName, this.packageName, version => {
            this.createVersionedTests(version)
          })
        }
      })
    })
  }

  createSingleVersionTests () {
    beforeEach(() => {
      this.tracer = require('../../dd-trace')
    })

    this.createTestBlocks()
  }

  createVersionedTests (version) {
    beforeEach(() => {
      this.tracer = require('../../dd-trace')
    })

    this.createTestBlocks(version)
  }

  createTestBlocks (version) {
    describe('without configuration', () => {
      before(() => {
        const plugins = [this.pluginName, ...this.options.additionalPlugins]
        const configs = [this.options.pluginConfig, ...this.options.additionalPlugins.map(() => ({})) ]
        return agent.load(plugins, configs)
      })

      after(() => {
        return agent.close({ ritmReset: false })
      })

      beforeEach(async () => {
        if (version) {
          this.mod = require(\`../../../versions/\${this.packageName}@\${version}\`).get()
        } else {
          this.mod = require(this.packageName)
        }
        
        this.testSetup = new this.TestSetupClass()
        await this.testSetup.setup(this.mod)
      })

      afterEach(async () => {
        if (this.testSetup && this.testSetup.cleanup) {
          await this.testSetup.cleanup()
        }
      })

      // Generate the actual test cases
      this.generateTestCases()
    })
  }

  /**
   * Override this method in category-specific helpers or let AI generate it
   */
  generateTestCases () {
    // Basic module loading test
    it('should load the module correctly', () => {
      expect(this.mod).to.be.an('object')
      expect(this.testSetup).to.be.an('object')
    })

    // Basic instrumentation test
    it('should create spans for instrumented operations', (done) => {
      if (!this.testSetup.performBasicOperation) {
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

      this.testSetup.performBasicOperation().catch(done)
    })
  }
}

/**
 * Web Server Test Helper
 * Specialized helper for web server integrations
 */
class WebServerTestHelper extends IntegrationTestHelper {
  constructor (pluginName, packageName, TestSetupClass, options = {}) {
    super(pluginName, packageName, TestSetupClass, {
      additionalPlugins: ['http'],
      ...options
    })
  }

  generateTestCases () {
    super.generateTestCases()

    it('should instrument successful HTTP requests', (done) => {
      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', this.pluginName)
          expect(traces[0][0].meta).to.have.property('http.method', 'GET')
          expect(traces[0][0].meta).to.have.property('http.status_code', '200')
          expect(traces[0][0].meta).to.have.property('span.kind', 'server')
        })
        .then(done)
        .catch(done)

      this.testSetup.makeSuccessfulRequest().catch(done)
    })

    it('should instrument HTTP error responses', (done) => {
      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.have.property('error', 1)
          expect(traces[0][0].meta).to.have.property('http.status_code', '500')
        })
        .then(done)
        .catch(done)

      this.testSetup.makeErrorRequest().then(() => {}).catch(done)
    })

    it('should instrument parameterized routes', (done) => {
      if (!this.testSetup.makeParameterizedRequest) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0].meta).to.have.property('http.route')
        })
        .then(done)
        .catch(done)

      this.testSetup.makeParameterizedRequest().catch(done)
    })
  }
}

/**
 * Database Test Helper
 * Specialized helper for database client integrations
 */
class DatabaseTestHelper extends IntegrationTestHelper {
  generateTestCases () {
    super.generateTestCases()

    it('should instrument database read operations', (done) => {
      if (!this.testSetup.performRead) {
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
          expect(traces[0][0].meta).to.have.property('db.type')
        })
        .then(done)
        .catch(done)

      this.testSetup.performRead().catch(done)
    })

    it('should instrument database write operations', (done) => {
      if (!this.testSetup.performWrite) {
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

      this.testSetup.performWrite().catch(done)
    })
  }
}

/**
 * Messaging Test Helper
 * Specialized helper for messaging/queue integrations
 */
class MessagingTestHelper extends IntegrationTestHelper {
  generateTestCases () {
    super.generateTestCases()

    it('should instrument message production', (done) => {
      if (!this.testSetup.addJob) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', this.pluginName)
          expect(traces[0][0].meta).to.have.property('span.kind', 'producer')
        })
        .then(done)
        .catch(done)

      this.testSetup.addJob().catch(done)
    })

    it('should instrument message consumption', (done) => {
      if (!this.testSetup.addJob || !this.testSetup.waitForJobCompletion) {
        done()
        return
      }

      agent
        .assertSomeTraces(traces => {
          // Should have both producer and consumer spans
          expect(traces).to.have.length.greaterThan(0)
          const spans = traces.flat()
          const consumerSpan = spans.find(span => span.meta && span.meta['span.kind'] === 'consumer')
          expect(consumerSpan).to.exist
          expect(consumerSpan.meta).to.have.property('component', this.pluginName)
        })
        .then(done)
        .catch(done)

      this.testSetup.addJob()
        .then(job => this.testSetup.waitForJobCompletion(job))
        .catch(done)
    })
  }
}

module.exports = {
  IntegrationTestHelper,
  WebServerTestHelper,
  DatabaseTestHelper,
  MessagingTestHelper
}`
}

module.exports = {
  generateIntegrationTestHelper
}
