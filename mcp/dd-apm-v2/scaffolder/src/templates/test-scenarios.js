'use strict'

/**
 * Test Scenario Templates for Different Integration Categories
 * AI can use these templates to generate working test setups
 */

function generateWebServerTestSetup (integrationName, packageName) {
  const className = `${integrationName.charAt(0).toUpperCase() + integrationName.slice(1)}TestSetup`

  return `'use strict'

const axios = require('axios')

/**
 * ${integrationName} Web Server Test Setup
 * Provides common web server testing scenarios
 */
class ${className} {
  constructor () {
    this.app = null
    this.server = null
    this.port = null
    this.baseUrl = null
  }

  async setup (${integrationName}Module) {
    this.app = ${integrationName}Module()
    
    // Basic health check endpoint
    this.app.get('/health', (req, res) => {
      res.status(200).json({ status: 'ok' })
    })
    
    // Parameterized route
    this.app.get('/user/:id', (req, res) => {
      res.status(200).json({ id: req.params.id, name: 'Test User' })
    })
    
    // POST endpoint
    this.app.post('/user', (req, res) => {
      res.status(201).json({ id: Date.now(), created: true })
    })
    
    // Error endpoint
    this.app.get('/error', (req, res) => {
      throw new Error('Test error for instrumentation')
    })
    
    // Error handler middleware
    this.app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message })
    })
    
    return new Promise((resolve) => {
      this.server = this.app.listen(0, 'localhost', () => {
        this.port = this.server.address().port
        this.baseUrl = \`http://localhost:\${this.port}\`
        resolve()
      })
    })
  }

  async cleanup () {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(resolve)
      })
    }
  }

  // Test actions
  async makeSuccessfulRequest () {
    return axios.get(\`\${this.baseUrl}/health\`)
  }

  async makeParameterizedRequest (userId = '123') {
    return axios.get(\`\${this.baseUrl}/user/\${userId}\`)
  }

  async makePostRequest (data = { name: 'Test User' }) {
    return axios.post(\`\${this.baseUrl}/user\`, data)
  }

  async makeErrorRequest () {
    try {
      return await axios.get(\`\${this.baseUrl}/error\`)
    } catch (error) {
      return error.response
    }
  }
}

module.exports = { ${className} }`
}

function generateDatabaseTestSetup (integrationName, packageName) {
  const className = `${integrationName.charAt(0).toUpperCase() + integrationName.slice(1)}TestSetup`

  return `'use strict'

/**
 * ${integrationName} Database Client Test Setup
 * Provides common database testing scenarios
 */
class ${className} {
  constructor () {
    this.client = null
  }

  async setup (${integrationName}Module) {
    // TODO: Configure connection based on specific database
    this.client = ${integrationName}Module.createClient({
      host: 'localhost',
      port: 6379, // TODO: Use appropriate port for database
      database: 'test'
    })
    
    await this.client.connect()
  }

  async cleanup () {
    if (this.client) {
      await this.client.disconnect()
    }
  }

  // Test actions
  async performRead (key = 'test-key') {
    return this.client.get(key)
  }

  async performWrite (key = 'test-key', value = 'test-value') {
    return this.client.set(key, value)
  }

  async performQuery (query = 'SELECT 1') {
    return this.client.query(query)
  }

  async performTransaction () {
    const transaction = this.client.multi()
    transaction.set('key1', 'value1')
    transaction.set('key2', 'value2')
    transaction.get('key1')
    return transaction.exec()
  }

  async performErrorOperation () {
    try {
      return await this.client.query('INVALID SQL QUERY')
    } catch (error) {
      return error
    }
  }
}

module.exports = { ${className} }`
}

function generateMessagingTestSetup (integrationName, packageName) {
  const className = `${integrationName.charAt(0).toUpperCase() + integrationName.slice(1)}TestSetup`

  return `'use strict'

/**
 * ${integrationName} Messaging Queue Test Setup
 * Provides common messaging/queue testing scenarios
 */
class ${className} {
  constructor () {
    this.queue = null
    this.worker = null
    this.connection = { host: 'localhost', port: 6379 }
  }

  async setup (${integrationName}Module) {
    const { Queue, Worker } = ${integrationName}Module
    
    this.queue = new Queue('test-queue', { connection: this.connection })
    
    // Set up a worker to process jobs
    this.worker = new Worker('test-queue', async (job) => {
      if (job.name === 'error-job') {
        throw new Error('Test job processing error')
      }
      return { result: 'processed', data: job.data }
    }, { connection: this.connection })

    await this.worker.waitUntilReady()
  }

  async cleanup () {
    if (this.worker) {
      await this.worker.close()
    }
    if (this.queue) {
      await this.queue.close()
    }
  }

  // Test actions
  async addJob (data = { message: 'test job' }) {
    return this.queue.add('test-job', data)
  }

  async addDelayedJob (data = { message: 'delayed job' }, delay = 1000) {
    return this.queue.add('delayed-job', data, { delay })
  }

  async addErrorJob () {
    return this.queue.add('error-job', { message: 'will fail' })
  }

  async waitForJobCompletion (job) {
    return job.waitUntilFinished()
  }

  async addBulkJobs (count = 5) {
    const jobs = []
    for (let i = 0; i < count; i++) {
      jobs.push({ name: 'bulk-job', data: { index: i } })
    }
    return this.queue.addBulk(jobs)
  }
}

module.exports = { ${className} }`
}

function generateHttpClientTestSetup (integrationName, packageName) {
  const className = `${integrationName.charAt(0).toUpperCase() + integrationName.slice(1)}TestSetup`

  return `'use strict'

const http = require('http')

/**
 * ${integrationName} HTTP Client Test Setup
 * Provides common HTTP client testing scenarios
 */
class ${className} {
  constructor () {
    this.httpClient = null
    this.testServer = null
    this.testPort = null
  }

  async setup (${integrationName}Module) {
    this.httpClient = ${integrationName}Module
    
    // Set up a test HTTP server to make requests against
    this.testServer = http.createServer((req, res) => {
      const url = req.url
      const method = req.method
      
      if (url === '/success') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, method }))
      } else if (url === '/error') {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Server error' }))
      } else if (url === '/timeout') {
        // Don't respond, let it timeout
        return
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
      }
    })
    
    return new Promise((resolve) => {
      this.testServer.listen(0, 'localhost', () => {
        this.testPort = this.testServer.address().port
        resolve()
      })
    })
  }

  async cleanup () {
    if (this.testServer) {
      return new Promise((resolve) => {
        this.testServer.close(resolve)
      })
    }
  }

  // Test actions
  async makeSuccessfulRequest () {
    return this.httpClient.get(\`http://localhost:\${this.testPort}/success\`)
  }

  async makeErrorRequest () {
    try {
      return await this.httpClient.get(\`http://localhost:\${this.testPort}/error\`)
    } catch (error) {
      return error
    }
  }

  async makePostRequest (data = { test: 'data' }) {
    return this.httpClient.post(\`http://localhost:\${this.testPort}/success\`, data)
  }

  async makeTimeoutRequest () {
    try {
      return await this.httpClient.get(\`http://localhost:\${this.testPort}/timeout\`, {
        timeout: 100
      })
    } catch (error) {
      return error
    }
  }
}

module.exports = { ${className} }`
}

function generateGenericTestSetup (integrationName, packageName) {
  const className = `${integrationName.charAt(0).toUpperCase() + integrationName.slice(1)}TestSetup`

  return `'use strict'

/**
 * ${integrationName} Generic Test Setup
 * Basic setup for library instrumentation testing
 */
class ${className} {
  constructor () {
    this.module = null
  }

  async setup (${integrationName}Module) {
    this.module = ${integrationName}Module
    // TODO: Add any necessary initialization
  }

  async cleanup () {
    // TODO: Add cleanup logic if needed
  }

  // Test actions
  async performBasicOperation () {
    // TODO: Implement basic module operation
    return this.module.someMethod ? this.module.someMethod() : 'no-op'
  }

  async performAsyncOperation () {
    // TODO: Implement async operation
    return Promise.resolve('async-result')
  }

  async performErrorOperation () {
    // TODO: Implement error scenario
    throw new Error('Test error for instrumentation')
  }
}

module.exports = { ${className} }`
}

module.exports = {
  generateWebServerTestSetup,
  generateDatabaseTestSetup,
  generateMessagingTestSetup,
  generateHttpClientTestSetup,
  generateGenericTestSetup
}
