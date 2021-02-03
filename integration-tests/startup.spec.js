'use strict'

const {
  FakeAgent,
  spawnProc,
  curlAndAssertMessage,
  curl
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
        assert.propertyVal(payload[0][0].meta, 'foo', 'bar')
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
        assert.propertyVal(payload[0][0].meta, 'foo', 'bar')
      })
    })

    it('uses log exporter correctly', async () => {
      proc = await spawnProc(startupTestFile, {
        env: {
          AWS_LAMBDA_FUNCTION_NAME: 'fake-lambda'
        },
        stdio: 'pipe'
      })
      const logPromise = new Promise((resolve, reject) => {
        proc.once('logLine', line => {
          try {
            const { traces } = JSON.parse(line)
            assert.isArray(traces)
            assert.strictEqual(traces.length, 1)
            assert.isArray(traces[0])
            assert.strictEqual(traces[0].length, 1)
            assert.propertyVal(traces[0][0], 'name', 'http.request')
            assert.propertyVal(traces[0][0].meta, 'foo', 'bar')
            resolve()
          } catch (e) {
            reject(e)
          }
        })
      })
      const curlPromise = curl(proc)
      return Promise.all([logPromise, curlPromise])
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
        assert.propertyVal(payload[0][0].meta, 'foo', 'bar')
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
        assert.propertyVal(payload[0][0].meta, 'foo', 'bar')
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
        assert.propertyVal(payload[0][0].meta, 'foo', 'bar')
      })
    })
  })
})
