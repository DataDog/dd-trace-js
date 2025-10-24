'use strict'

class PolkaTestSetup {
  async setup (module) {
    this.app = null
    this.server = null
    this.port = 8080
    try {
      // Create Polka app with routes
      this.app = module()

      // Add some middleware
      this.app.use((req, res, next) => {
        next()
      })

      // Add routes that will trigger the handler method
      this.app.get('/', (req, res) => {
        res.end('Hello from Polka!')
      })

      this.app.post('/', (req, res) => {
        res.end(JSON.stringify({ success: true }))
      })

      this.app.get('/api/users', (req, res) => {
        res.end(JSON.stringify({ users: ['Alice', 'Bob'] }))
      })

      this.app.post('/api/data', (req, res) => {
        res.end(JSON.stringify({ success: true }))
      })

      // Add parameterized route for testing
      this.app.get('/users/:id', (req, res) => {
        res.end(JSON.stringify({ userId: req.params.id }))
      })

      // Add error route for testing error handling
      this.app.get('/error', (req, res) => {
        res.statusCode = 500
        res.end('Internal Server Error')
      })

      // Start the server
      await new Promise((resolve, reject) => {
        this.server = this.app.listen(this.port, (err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      })
    } catch (error) {
      throw error
    }
  }

  async teardown () {
    if (this.app && this.app.server) {
      await new Promise((resolve, reject) => {
        this.app.server.close((err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
    this.app = null
    this.server = null
  }

  // --- Operations ---
  async handle_request ({ method, path, expectError = false } = {}) {
    try {
      // If expectError is true, make a request to an error route
      if (expectError) {
        return await this.makeRequest('GET', '/error')
      }

      // If a specific method and path are provided, use them
      if (method && path) {
        return await this.makeRequest(method, path)
      }

      // Otherwise, test all routes (for backward compatibility)
      await this.makeRequest('GET', '/')
      await this.makeRequest('GET', '/api/users')
      await this.makeRequest('POST', '/api/data', JSON.stringify({ test: 'data' }))
    } catch (error) {
      // Continue execution
    }
  }

  async runAll () {
    try {
      await this.setup()

      await this.handle_request()
    } catch (error) {
      process.exit(1)
    } finally {
      await this.teardown()
    }
  }

  makeRequest (method, path, body) {
    const http = require('http')
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'localhost',
        port: this.port,
        path,
        method
      }

      const req = http.request(options, (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: data })
        })
      })

      req.on('error', reject)

      if (body) {
        req.write(body)
      }

      req.end()
    })
  }
}

module.exports = PolkaTestSetup
