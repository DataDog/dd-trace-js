'use strict'

const { createSandbox, FakeAgent, spawnProc } = require('../helpers')
const path = require('path')

describe('Endpoints collection', () => {
  let sandbox, cwd

  before(async function () {
    this.timeout(process.platform === 'win32' ? 90000 : 30000)

    sandbox = await createSandbox(
      ['express', 'fastify'],
      false
    )

    cwd = sandbox.folder
  })

  after(async function () {
    this.timeout(60000)
    await sandbox.remove()
  })

  function getExpectedEndpoints (framework) {
    const expectedEndpoints = [
      // Basic routes
      { method: 'GET', path: '/users' },
      { method: 'HEAD', path: '/users' },
      { method: 'POST', path: '/users/' },
      { method: 'PUT', path: '/users/:id' },
      { method: 'DELETE', path: '/users/:id' },
      { method: 'PATCH', path: '/users/:id/:name' },

      // Additional methods
      { method: 'TRACE', path: '/trace-test' },
      { method: 'HEAD', path: '/head-test' },

      // Using app.route()
      { method: 'POST', path: '/multi-method' },
      { method: 'PUT', path: '/multi-method' },
      { method: 'PATCH', path: '/multi-method' },

      // Nested routes with Router
      { method: 'PUT', path: '/v1/nested/:id' },

      // Deeply nested routes
      { method: 'GET', path: '/api/nested' },
      { method: 'HEAD', path: '/api/nested' },
      { method: 'GET', path: '/api/sub/deep' },
      { method: 'HEAD', path: '/api/sub/deep' },
      { method: 'POST', path: '/api/sub/deep/:id' },

      { method: 'GET', path: '/later' },
      { method: 'HEAD', path: '/later' },
    ]

    if (framework === 'fastify') {
      expectedEndpoints.push({ method: 'OPTIONS', path: '/users/:id?' })

      // Route with regex - not supported in express5
      expectedEndpoints.push({ method: 'DELETE', path: '/regex/:hour(^\\d{2})h:minute(^\\d{2})m' })
      expectedEndpoints.push({ method: 'OPTIONS', path: '/users/:id?' })// Added with addHttpMethod
      expectedEndpoints.push({ method: 'MKCOL', path: '/example/near/:lat-:lng/radius/:r' })// Added with addHttpMethod

      // All supported methods route
      expectedEndpoints.push({ method: 'GET', path: '/all-methods' })
      expectedEndpoints.push({ method: 'HEAD', path: '/all-methods' })
      expectedEndpoints.push({ method: 'TRACE', path: '/all-methods' })
      expectedEndpoints.push({ method: 'DELETE', path: '/all-methods' })
      expectedEndpoints.push({ method: 'OPTIONS', path: '/all-methods' })
      expectedEndpoints.push({ method: 'PATCH', path: '/all-methods' })
      expectedEndpoints.push({ method: 'PUT', path: '/all-methods' })
      expectedEndpoints.push({ method: 'POST', path: '/all-methods' })
      expectedEndpoints.push({ method: 'GET', path: '/wildcard/*' })
      expectedEndpoints.push({ method: 'HEAD', path: '/wildcard/*' })
      // Wildcard routes
      expectedEndpoints.push({ method: 'GET', path: '*' })
      expectedEndpoints.push({ method: 'HEAD', path: '*' })
    }

    if (framework === 'express') {
      expectedEndpoints.push({ method: 'CONNECT', path: '/connect-test' })
      expectedEndpoints.push({ method: '*', path: '/multi-method' })
      expectedEndpoints.push({ method: '*', path: '/all-methods' })
      expectedEndpoints.push({ method: '*', path: '/wildcard/*name' })
      expectedEndpoints.push({ method: '*', path: '/^\\/login\\/.*$/i' })
      expectedEndpoints.push({ method: 'OPTIONS', path: '/users/:id' })
    }

    return expectedEndpoints
  }

  async function runEndpointTest (framework) {
    let agent, proc
    const appFile = path.join(cwd, 'appsec', 'endpoints-collection', `${framework}.js`)

    try {
      agent = await new FakeAgent().start()

      const expectedEndpoints = getExpectedEndpoints(framework)
      const endpointsFound = []
      const isFirstFlags = []

      const expectedMessageCount = framework === 'express' ? 3 : 4

      const telemetryPromise = agent.assertTelemetryReceived(({ payload }) => {
        isFirstFlags.push(Boolean(payload.payload.is_first))

        if (payload.payload.endpoints) {
          payload.payload.endpoints.forEach(endpoint => {
            endpointsFound.push({
              method: endpoint.method,
              path: endpoint.path,
              type: endpoint.type,
              operation_name: endpoint.operation_name,
              resource_name: endpoint.resource_name
            })
          })
        }
      }, 'app-endpoints', 5_000, expectedMessageCount)

      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
          DD_API_SECURITY_ENDPOINT_COLLECTION_MESSAGE_LIMIT: '10'
        }
      })

      await telemetryPromise

      const trueCount = isFirstFlags.filter(v => v === true).length
      expect(trueCount).to.equal(1)

      // Check that all expected endpoints were found
      expectedEndpoints.forEach(expected => {
        const found = endpointsFound.find(e =>
          e.method === expected.method && e.path === expected.path
        )

        expect(found).to.exist
        expect(found.type).to.equal('REST')
        expect(found.operation_name).to.equal('http.request')
        expect(found.resource_name).to.equal(`${expected.method} ${expected.path}`)
      })

      // check that no additional endpoints were found
      expect(endpointsFound.length).to.equal(expectedEndpoints.length)
    } finally {
      proc?.kill()
      await agent?.stop()
    }
  }

  it('should send express endpoints via telemetry', async () => {
    await runEndpointTest('express')
  })

  it('should send fastify endpoints via telemetry', async () => {
    await runEndpointTest('fastify')
  })
})
