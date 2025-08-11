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
      { method: 'POST', path: '/users' },
      { method: 'PUT', path: '/users/:id' },
      { method: 'DELETE', path: '/users/:id' },
      { method: 'PATCH', path: '/users/:id' },
      { method: 'OPTIONS', path: '/users' },

      // Additional methods
      { method: 'TRACE', path: '/trace-test' },
      { method: 'HEAD', path: '/head-test' },

      // Using app.route()
      { method: 'POST', path: '/multi-method' },

      // Wildcard route
      { method: '*', path: '/wildcard' },

      // Nested routes with Router
      { method: 'PUT', path: '/v1/nested/:id' },

      // Deeply nested routes
      { method: 'GET', path: '/api/sub/deep' },
      { method: 'HEAD', path: '/api/sub/deep' },
      { method: 'POST', path: '/api/sub/deep/:id' },
    ]

    return expectedEndpoints
  }

  async function runEndpointTest (framework) {
    let agent, proc
    const appFile = path.join(cwd, 'appsec', 'endpoints-collection', `${framework}.js`)

    try {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_TELEMETRY_HEARTBEAT_INTERVAL: 1,
          DD_API_SECURITY_ENDPOINT_COLLECTION_MESSAGE_LIMIT: '10'
        }
      })

      const expectedEndpoints = getExpectedEndpoints(framework)
      const endpointsFound = []

      await agent.assertTelemetryReceived(msg => {
        const { payload } = msg
        if (payload.request_type === 'app-endpoints') {
          expect(payload.payload.is_first).to.be.true

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
        }
      }, 'app-endpoints', 5_000, 2)

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
    } finally {
      proc?.kill()
      await agent?.stop()
    }
  }

  it('should send fastify endpoints via telemetry', async () => {
    await runEndpointTest('fastify')
  })
})
