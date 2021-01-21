'use strict'

const {
  FakeAgent,
  spawnProc,
  curlAndAssertMessage
} = require('./helpers')
const path = require('path')
const assert = require('assert')

const startupTestFile = path.join(__dirname, 'startup/index.js')

describe('startup', () => {
  let agent
  let proc

  context('programmatic', () => {
    beforeEach(async () => {
      agent = await new FakeAgent().ready()
    })

    afterEach(() => {
      proc.kill()
      agent.close()
    })

    it('works for options.port', async () => {
      proc = await spawnProc(startupTestFile, {
        env: {
          AGENT_PORT: agent.port
        }
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.strictEqual(payload.length, 1)
        assert.strictEqual(payload[0].length, 1)
        assert.strictEqual(payload[0][0].name, 'http.request')
      })
    })

    it('works for options.url', async () => {
      proc = await spawnProc(startupTestFile, {
        env: {
          AGENT_URL: `http://localhost:${agent.port}`
        }
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.strictEqual(headers.host, `localhost:${agent.port}`)
        assert.strictEqual(payload.length, 1)
        assert.strictEqual(payload[0].length, 1)
        assert.strictEqual(payload[0][0].name, 'http.request')
      })
    })
  })

  context('env var', () => {
    beforeEach(async () => {
      agent = await new FakeAgent().ready()
    })

    afterEach(() => {
      proc.kill()
      agent.close()
    })

    it('works for DD_TRACE_AGENT_PORT', async () => {
      proc = await spawnProc(startupTestFile, {
        env: {
          DD_TRACE_AGENT_PORT: agent.port
        }
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.strictEqual(payload.length, 1)
        assert.strictEqual(payload[0].length, 1)
        assert.strictEqual(payload[0][0].name, 'http.request')
      })
    })

    it('works for DD_TRACE_AGENT_URL', async () => {
      proc = await spawnProc(startupTestFile, {
        env: {
          DD_TRACE_AGENT_URL: `http://localhost:${agent.port}`
        }
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.strictEqual(headers.host, `localhost:${agent.port}`)
        assert.strictEqual(payload.length, 1)
        assert.strictEqual(payload[0].length, 1)
        assert.strictEqual(payload[0][0].name, 'http.request')
      })
    })
  })

  context('default', () => {
    beforeEach(async () => {
      // Note that this test will *always* listen on the default port. If that
      // port is unavailable, the test will fail.
      agent = await new FakeAgent(8126).ready()
    })

    afterEach(() => {
      proc.kill()
      agent.close()
    })

    it('works for hostname and port', async () => {
      proc = await spawnProc(startupTestFile)
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.strictEqual(headers.host, '127.0.0.1:8126')
        assert.strictEqual(payload.length, 1)
        assert.strictEqual(payload[0].length, 1)
        assert.strictEqual(payload[0][0].name, 'http.request')
      })
    })
  })
})
