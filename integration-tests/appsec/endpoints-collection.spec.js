'use strict'

const { expect } = require('chai')
const { describe, before, it } = require('mocha')

const path = require('node:path')

const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('../helpers')

describe('Endpoints collection', () => {
  let cwd

  useSandbox(['express', 'fastify'])

  before(function () {
    cwd = sandboxCwd()
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
      expectedEndpoints.push(
        // Route with regex - not supported in express5
        { method: 'DELETE', path: '/regex/:hour(^\\d{2})h:minute(^\\d{2})m' },

        { method: 'OPTIONS', path: '/users/:id?' },
        { method: 'MKCOL', path: '/example/near/:lat-:lng/radius/:r' }, // Added with addHttpMethod

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

        // Wildcard routes
        { method: 'GET', path: '/wildcard/*' },
        { method: 'HEAD', path: '/wildcard/*' },
        { method: 'GET', path: '*' },
        { method: 'HEAD', path: '*' }
      )
    }

    if (framework === 'express') {
      expectedEndpoints.push(
        { method: 'CONNECT', path: '/connect-test' },
        { method: '*', path: '/multi-method' },
        { method: '*', path: '/all-methods' },
        { method: '*', path: '/wildcard/*name' },
        { method: '*', path: '/^\\/login\\/.*$/i' },
        { method: 'OPTIONS', path: '/users/:id' },
        { method: 'PATCH', path: '/^\\/ab(cd)?$/' },
        { method: 'POST', path: '/array-route-one' },
        { method: 'POST', path: '/array-route-two' },
        { method: 'POST', path: '/api/array/array-one' },
        { method: 'POST', path: '/api/array/array-two' },
        { method: 'PUT', path: '/api/regex/^\\/item\\/(\\d+)$/' },
        { method: 'GET', path: '/multi-array' },
        { method: 'HEAD', path: '/multi-array' },
        { method: 'GET', path: '/multi-array/mounted' },
        { method: 'HEAD', path: '/multi-array/mounted' },
        { method: 'GET', path: '/multi-array-alt' },
        { method: 'HEAD', path: '/multi-array-alt' },
        { method: 'GET', path: '/multi-array-alt/mounted' },
        { method: 'HEAD', path: '/multi-array-alt/mounted' },
        { method: 'GET', path: '/^\\/regex-mount(?:\\/|$)/mounted' },
        { method: 'HEAD', path: '/^\\/regex-mount(?:\\/|$)/mounted' },

        // Multiple routers without mount path
        { method: 'PUT', path: '/router1' },
        { method: 'PUT', path: '/router2' },

        // Nested routers mounted after definitions
        { method: 'GET', path: '/root/path/path2/endpoint' },
        { method: 'HEAD', path: '/root/path/path2/endpoint' },

        // Same router mounted at multiple paths
        { method: 'GET', path: '/api/v1/shared-before' },
        { method: 'HEAD', path: '/api/v1/shared-before' },
        { method: 'GET', path: '/api/v2/shared-before' },
        { method: 'HEAD', path: '/api/v2/shared-before' },

        { method: 'GET', path: '/api/v1/shared-after' },
        { method: 'HEAD', path: '/api/v1/shared-after' },
        { method: 'GET', path: '/api/v2/shared-after' },
        { method: 'HEAD', path: '/api/v2/shared-after' }
      )
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

      const expectedMessageCount = framework === 'express' ? 7 : 4

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
          DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
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

      // Explicitly verify invalid endpoints are NOT reported
      if (framework === 'express') {
        const cycleEndpoints = endpointsFound.filter(e => e.path.includes('cycle'))
        expect(cycleEndpoints).to.have.lengthOf(0, 'Cycle router endpoints should not be collected')

        const invalidEndpoints = endpointsFound.filter(e => e.path.includes('invalid'))
        expect(invalidEndpoints).to.have.lengthOf(0, 'Invalid router paths should not be collected')
      }
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
