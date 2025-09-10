/**
 * EXAMPLE: Simplified Test Setup Architecture for AI-Generated Integration Tests
 * 
 * This demonstrates how we can separate test setup logic from test assertions,
 * making it easier for AI to generate working test scenarios.
 */

// =============================================================================
// 1. TEST SETUP FILE (AI-generated, scenario-specific)
// =============================================================================
// File: packages/datadog-plugin-express/test/scenarios/web-server-setup.js

'use strict'

const axios = require('axios')

/**
 * Express Web Server Test Setup
 * AI generates this file with specific scenarios for the integration
 */
class ExpressTestSetup {
  constructor() {
    this.app = null
    this.server = null
    this.port = null
    this.baseUrl = null
  }

  async setup(express) {
    this.app = express()
    
    // Basic routes that AI knows how to create
    this.app.get('/health', (req, res) => {
      res.status(200).json({ status: 'ok' })
    })
    
    this.app.get('/user/:id', (req, res) => {
      res.status(200).json({ id: req.params.id, name: 'John Doe' })
    })
    
    this.app.post('/user', (req, res) => {
      res.status(201).json({ id: 123, name: 'Created User' })
    })
    
    // Error scenario
    this.app.get('/error', (req, res) => {
      throw new Error('Test error')
    })
    
    // Error handler
    this.app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message })
    })
    
    return new Promise((resolve) => {
      this.server = this.app.listen(0, 'localhost', () => {
        this.port = this.server.address().port
        this.baseUrl = `http://localhost:${this.port}`
        resolve()
      })
    })
  }

  async cleanup() {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(resolve)
      })
    }
  }

  // Test actions that AI can use
  async makeSuccessfulRequest() {
    return axios.get(`${this.baseUrl}/health`)
  }

  async makeParameterizedRequest(userId = '123') {
    return axios.get(`${this.baseUrl}/user/${userId}`)
  }

  async makePostRequest() {
    return axios.post(`${this.baseUrl}/user`, { name: 'Test User' })
  }

  async makeErrorRequest() {
    try {
      return await axios.get(`${this.baseUrl}/error`)
    } catch (error) {
      return error.response
    }
  }
}

module.exports = { ExpressTestSetup }

// =============================================================================
// 2. TEST HELPER (Reusable, handles all the boilerplate)
// =============================================================================
// File: packages/dd-trace/test/setup/integration-test-helper.js

'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach, before, after } = require('mocha')
const agent = require('../plugins/agent')
const { withVersions } = require('./mocha')

/**
 * Integration Test Helper
 * Handles all the boilerplate setup that's common across integration tests
 */
class IntegrationTestHelper {
  constructor(pluginName, packageName, TestSetupClass) {
    this.pluginName = pluginName
    this.packageName = packageName
    this.TestSetupClass = TestSetupClass
    this.testSetup = null
    this.mod = null
    this.tracer = null
  }

  /**
   * Create the standard test structure with all the boilerplate
   */
  createTestSuite() {
    describe('Plugin', () => {
      describe(this.pluginName, () => {
        withVersions(this.pluginName, this.packageName, version => {
          beforeEach(() => {
            this.tracer = require('../../dd-trace')
          })

          describe('without configuration', () => {
            before(() => {
              return agent.load([this.pluginName, 'http'], [{}, { client: false }])
            })

            after(() => {
              return agent.close({ ritmReset: false })
            })

            beforeEach(async () => {
              this.mod = require(`../../../versions/${this.packageName}@${version}`).get()
              this.testSetup = new this.TestSetupClass()
              await this.testSetup.setup(this.mod)
            })

            afterEach(async () => {
              if (this.testSetup) {
                await this.testSetup.cleanup()
              }
            })

            // This is where AI-generated tests get injected
            this.generateTests()
          })
        })
      })
    })
  }

  /**
   * AI generates this method with specific test scenarios
   */
  generateTests() {
    // Basic instrumentation test
    it('should instrument successful requests', (done) => {
      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'express.request',
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', 'express')
          expect(traces[0][0].meta).to.have.property('http.method', 'GET')
          expect(traces[0][0].meta).to.have.property('http.status_code', '200')
        })
        .then(done)
        .catch(done)

      this.testSetup.makeSuccessfulRequest().catch(done)
    })

    // Error handling test
    it('should instrument error requests', (done) => {
      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'express.request',
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('component', 'express')
          expect(traces[0][0].meta).to.have.property('http.status_code', '500')
          expect(traces[0][0]).to.have.property('error', 1)
        })
        .then(done)
        .catch(done)

      this.testSetup.makeErrorRequest().then(() => {}).catch(done)
    })

    // Parameterized request test
    it('should instrument parameterized requests', (done) => {
      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'express.request',
            service: 'test',
            resource: 'GET /user/:id'
          })
          expect(traces[0][0].meta).to.have.property('http.route', '/user/:id')
        })
        .then(done)
        .catch(done)

      this.testSetup.makeParameterizedRequest('456').catch(done)
    })

    // POST request test
    it('should instrument POST requests', (done) => {
      agent
        .assertSomeTraces(traces => {
          expect(traces[0][0]).to.deep.include({
            name: 'express.request',
            service: 'test'
          })
          expect(traces[0][0].meta).to.have.property('http.method', 'POST')
          expect(traces[0][0].meta).to.have.property('http.status_code', '201')
        })
        .then(done)
        .catch(done)

      this.testSetup.makePostRequest().catch(done)
    })
  }
}

module.exports = { IntegrationTestHelper }

// =============================================================================
// 3. ACTUAL TEST FILE (Minimal, just wires everything together)
// =============================================================================
// File: packages/datadog-plugin-express/test/index.spec.js

'use strict'

const { IntegrationTestHelper } = require('../../dd-trace/test/setup/integration-test-helper')
const { ExpressTestSetup } = require('./scenarios/web-server-setup')

// Just wire up the helper with the test setup
const testHelper = new IntegrationTestHelper('express', 'express', ExpressTestSetup)
testHelper.createTestSuite()

// =============================================================================
// 4. DATABASE CLIENT EXAMPLE
// =============================================================================
// File: packages/datadog-plugin-redis/test/scenarios/redis-client-setup.js

'use strict'

class RedisTestSetup {
  constructor() {
    this.client = null
  }

  async setup(redis) {
    this.client = redis.createClient({ url: 'redis://127.0.0.1:6379' })
    await this.client.connect()
  }

  async cleanup() {
    if (this.client) {
      await this.client.quit()
    }
  }

  // Test actions for Redis
  async performGet(key = 'test-key') {
    return this.client.get(key)
  }

  async performSet(key = 'test-key', value = 'test-value') {
    return this.client.set(key, value)
  }

  async performMultipleOperations() {
    const multi = this.client.multi()
    multi.set('key1', 'value1')
    multi.set('key2', 'value2')
    multi.get('key1')
    return multi.exec()
  }

  async performErrorOperation() {
    // Force an error by using invalid command
    try {
      return await this.client.sendCommand(['INVALID_COMMAND'])
    } catch (error) {
      return error
    }
  }
}

module.exports = { RedisTestSetup }

// =============================================================================
// 5. MESSAGING QUEUE EXAMPLE
// =============================================================================
// File: packages/datadog-plugin-bullmq/test/scenarios/queue-setup.js

'use strict'

class BullMQTestSetup {
  constructor() {
    this.queue = null
    this.worker = null
    this.connection = { host: 'localhost', port: 6379 }
  }

  async setup(bullmq) {
    const { Queue, Worker } = bullmq
    
    this.queue = new Queue('test-queue', { connection: this.connection })
    
    // Set up a worker to process jobs
    this.worker = new Worker('test-queue', async (job) => {
      if (job.name === 'error-job') {
        throw new Error('Test job error')
      }
      return { result: 'processed', data: job.data }
    }, { connection: this.connection })

    // Wait for worker to be ready
    await this.worker.waitUntilReady()
  }

  async cleanup() {
    if (this.worker) {
      await this.worker.close()
    }
    if (this.queue) {
      await this.queue.close()
    }
  }

  // Test actions for BullMQ
  async addJob(data = { message: 'test' }) {
    return this.queue.add('test-job', data)
  }

  async addJobWithDelay(data = { message: 'delayed' }, delay = 1000) {
    return this.queue.add('delayed-job', data, { delay })
  }

  async addErrorJob() {
    return this.queue.add('error-job', { message: 'will fail' })
  }

  async waitForJobCompletion(job) {
    return job.waitUntilFinished()
  }
}

module.exports = { BullMQTestSetup }`
