'use strict'

const { createSandbox, FakeAgent, spawnProc } = require('../helpers')
const path = require('path')

describe('Endpoints collection', () => {
  let sandbox, cwd

  before(async function () {
    this.timeout(process.platform === 'win32' ? 90000 : 30000)

    sandbox = await createSandbox(
      ['fastify'],
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
      { method: 'OPTIONS', path: '/users/:id?' },

      // Route with regex
      { method: 'DELETE', path: '/regex/:hour(^\\d{2})h:minute(^\\d{2})m' },

      // Additional methods
      { method: 'TRACE', path: '/trace-test' },
      { method: 'HEAD', path: '/head-test' },

      // Custom method
      { method: 'MKCOL', path: '/example/near/:lat-:lng/radius/:r' },

      // Using app.route()
      { method: 'POST', path: '/multi-method' },
      { method: 'PUT', path: '/multi-method' },
      { method: 'PATCH', path: '/multi-method' },

      // All supported methods route
      { method: 'GET', path: '/all-methods' },
      { method: 'HEAD', path: '/all-methods' },
      { method: 'TRACE', path: '/all-methods' },
      { method: 'DELETE', path: '/all-methods' },
      { method: 'OPTIONS', path: '/all-methods' },
      { method: 'PATCH', path: '/all-methods' },
      { method: 'PUT', path: '/all-methods' },
      { method: 'POST', path: '/all-methods' },
      { method: 'MKCOL', path: '/all-methods' }, // Added with addHttpMethod

      // Nested routes with Router
      { method: 'PUT', path: '/v1/nested/:id' },

      // Deeply nested routes
      { method: 'GET', path: '/api/nested' },
      { method: 'HEAD', path: '/api/nested' },
      { method: 'GET', path: '/api/sub/deep' },
      { method: 'HEAD', path: '/api/sub/deep' },
      { method: 'POST', path: '/api/sub/deep/:id' },

      // Wildcard routes
      { method: 'GET', path: '/wildcard/*' },
      { method: 'HEAD', path: '/wildcard/*' },
      { method: 'GET', path: '*' },
      { method: 'HEAD', path: '*' },

      { method: 'GET', path: '/later' },
      { method: 'HEAD', path: '/later' },
    ]

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
      }, 'app-endpoints', 5_000, 4)

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

  it('should send fastify endpoints via telemetry', async () => {
    await runEndpointTest('fastify')
  })
})
