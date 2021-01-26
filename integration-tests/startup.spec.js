'use strict'

const {
  FakeAgent,
  spawnProc,
  curlAndAssertMessage
} = require('./helpers')
const path = require('path')
const { assert } = require('chai')

const startupTestFile = path.join(__dirname, 'startup/index.js')

describe('startup', () => {
  let agent
  let proc

  context('programmatic', () => {
    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('works for options.port', async () => {
      proc = await spawnProc(startupTestFile, {
        env: {
          AGENT_PORT: agent.port
        }
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])
        assert.strictEqual(payload[0].length, 1)
        assert.propertyVal(payload[0][0], 'name', 'http.request')
      })
    })

    it('works for options.url and options.scope: async_hooks', async () => {
      proc = await spawnProc(startupTestFile, {
        env: {
          AGENT_URL: `http://localhost:${agent.port}`,
          SCOPE: 'async_hooks'
        }
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `localhost:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])
        assert.strictEqual(payload[0].length, 1)
        assert.propertyVal(payload[0][0], 'name', 'http.request')
      })
    })

    it('uses log exporter correctly', async () => {
      proc = await spawnProc(startupTestFile, {
        env: {
          AWS_LAMBDA_FUNCTION_NAME: 'fake-lambda'
        },
        stdio: 'pipe'
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload, log }) => {
        assert.isUndefined(headers)
        assert.isUndefined(payload)
        assert.isArray(log)
        assert.strictEqual(log.length, 1)
        assert.isArray(log[0])
        assert.strictEqual(log[0].length, 1)
        assert.propertyVal(log[0][0], 'name', 'http.request')
      })
    })
  })

  context('env var', () => {
    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('works for DD_TRACE_AGENT_PORT', async () => {
      proc = await spawnProc(startupTestFile, {
        env: {
          DD_TRACE_AGENT_PORT: agent.port
        }
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])
        assert.strictEqual(payload[0].length, 1)
        assert.propertyVal(payload[0][0], 'name', 'http.request')
      })
    })

    it('works for DD_TRACE_AGENT_URL and DD_TRACE_SCOPE=async_resource', async () => {
      proc = await spawnProc(startupTestFile, {
        env: {
          DD_TRACE_AGENT_URL: `http://localhost:${agent.port}`,
          DD_TRACE_SCOPE: 'async_resource'
        }
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `localhost:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])
        assert.strictEqual(payload[0].length, 1)
        assert.propertyVal(payload[0][0], 'name', 'http.request')
      })
    })
  })

  context('default', () => {
    beforeEach(async () => {
      // Note that this test will *always* listen on the default port. If that
      // port is unavailable, the test will fail.
      agent = await new FakeAgent(8126).start()
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('works for hostname and port', async () => {
      proc = await spawnProc(startupTestFile)
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', '127.0.0.1:8126')
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])
        assert.strictEqual(payload[0].length, 1)
        assert.propertyVal(payload[0][0], 'name', 'http.request')
      })
    })
  })
})
