'use strict'

const http = require('http')

// APM Test Agent Client for dd-apm-test-agent communication
class TestAgentClient {
  constructor (options = {}) {
    this.host = options.host || 'localhost'
    this.port = options.port || 8126
    this.baseUrl = `http://${this.host}:${this.port}`
  }

  async request (method, path, data = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.host,
        port: this.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        }
      }

      const req = http.request(options, (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          try {
            const result = {
              statusCode: res.statusCode,
              headers: res.headers,
              body: body ? JSON.parse(body) : null,
              rawBody: body
            }
            resolve(result)
          } catch (error) {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: null,
              rawBody: body
            })
          }
        })
      })

      req.on('error', reject)

      if (data) {
        const jsonData = typeof data === 'string' ? data : JSON.stringify(data)
        req.write(jsonData)
      }

      req.end()
    })
  }

  async startSession (sessionToken, options = {}) {
    const params = new URLSearchParams()
    params.set('test_session_token', sessionToken)

    if (options.agentSampleRateByService) {
      params.set('agent_sample_rate_by_service', JSON.stringify(options.agentSampleRateByService))
    }

    const response = await this.request('POST', `/test/session/start?${params}`)

    if (response.statusCode !== 200) {
      throw new Error(`Failed to start test session: ${response.statusCode} - ${response.rawBody}`)
    }

    return response
  }

  async stopSession (sessionToken, options = {}) {
    const params = new URLSearchParams()
    params.set('test_session_token', sessionToken)

    if (options.ignores) {
      params.set('ignores', Array.isArray(options.ignores) ? options.ignores.join(',') : options.ignores)
    }

    if (options.removes) {
      params.set('removes', Array.isArray(options.removes) ? options.removes.join(',') : options.removes)
    }

    if (options.dir) {
      params.set('dir', options.dir)
    }

    if (options.file) {
      params.set('file', options.file)
    }

    const response = await this.request('POST', `/test/session/snapshot?${params}`)

    return response
  }

  async getTraceCheckFailures (sessionToken, options = {}) {
    const params = new URLSearchParams()
    params.set('test_session_token', sessionToken)

    if (options.useJson) {
      params.set('use_json', 'true')
    }

    if (options.returnAll) {
      params.set('return_all', 'true')
    }

    const response = await this.request('GET', `/test/trace_check/failures?${params}`)

    return response
  }

  async getTraceCheckSummary (sessionToken, options = {}) {
    const params = new URLSearchParams()
    params.set('test_session_token', sessionToken)

    if (options.returnAll) {
      params.set('return_all', 'true')
    }

    const response = await this.request('GET', `/test/trace_check/summary?${params}`)

    return response
  }

  async clearTraceCheckFailures (sessionToken, options = {}) {
    const params = new URLSearchParams()
    params.set('test_session_token', sessionToken)

    if (options.clearAll) {
      params.set('clear_all', 'true')
    }

    const response = await this.request('GET', `/test/trace_check/clear?${params}`)

    return response
  }

  async getSessionTraces (sessionToken) {
    const params = new URLSearchParams()
    params.set('test_session_token', sessionToken)

    const response = await this.request('GET', `/test/session/traces?${params}`)

    return response
  }

  async getSessionRequests (sessionToken) {
    const params = new URLSearchParams()
    params.set('test_session_token', sessionToken)

    const response = await this.request('GET', `/test/session/requests?${params}`)

    return response
  }

  async updateIntegrationInfo (sessionToken, integrationInfo) {
    const params = new URLSearchParams()
    params.set('test_session_token', sessionToken)

    const response = await this.request('PUT', `/test/session/integrations?${params}`, integrationInfo)

    return response
  }

  generateSessionToken (testName, timestamp = Date.now()) {
    return `${testName}-${timestamp}-${Math.random().toString(36).substr(2, 9)}`
  }
}

module.exports = { TestAgentClient }
