'use strict'

const {
  FakeAgent,
  spawnProc,
  createSandbox,
  curlAndAssertMessage
} = require('./helpers')
const path = require('path')
const { assert } = require('chai')

describe('startup', () => {
  let agent
  let proc
  let sandbox
  let cwd
  let startupTestFile

  before(async () => {
    sandbox = await createSandbox()
    cwd = sandbox.folder
    startupTestFile = path.join(cwd, 'startup/index.js')
  })

  after(async () => {
    await sandbox.remove()
  })

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
        cwd,
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

    it('works for options.url', async () => {
      proc = await spawnProc(startupTestFile, {
        cwd,
        env: {
          AGENT_URL: `http://localhost:${agent.port}`
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
        cwd,
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

    it('works for DD_TRACE_AGENT_URL', async () => {
      proc = await spawnProc(startupTestFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_URL: `http://localhost:${agent.port}`
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

    it('works with stealthy-require', async () => {
      proc = await spawnProc(startupTestFile, {
        cwd,
        env: {
          STEALTHY_REQUIRE: 'true'
        }
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', '127.0.0.1:8126')
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])
        assert.strictEqual(payload[0].length, 1)
        assert.propertyVal(payload[0][0], 'name', 'web.request')
      })
    })
  })
})
