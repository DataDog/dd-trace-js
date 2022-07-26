'use strict'

const {
  FakeAgent,
  spawnProc,
  createSandbox,
  curlAndAssertMessage
} = require('./helpers')
const path = require('path')
const { assert } = require('chai')

const hookFile = 'dd-trace/loader-hook.mjs'

describe('esm', () => {
  let agent
  let proc
  let sandbox
  let cwd

  before(async () => {
    sandbox = await createSandbox(['express'])
    cwd = sandbox.folder
  })

  after(async () => {
    await sandbox.remove()
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    proc && proc.kill()
    await agent.stop()
  })

  context('http', () => {
    it('is instrumented', async () => {
      proc = await spawnProc(path.join(cwd, 'esm/http.mjs'), {
        cwd,
        env: {
          NODE_OPTIONS: `--loader=${hookFile}`,
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
  })

  context('express', () => {
    it('is instrumented', async () => {
      proc = await spawnProc(path.join(cwd, 'esm/express.mjs'), {
        cwd,
        env: {
          NODE_OPTIONS: `--loader=${hookFile}`,
          AGENT_PORT: agent.port
        }
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])
        assert.strictEqual(payload[0].length, 4)
        assert.propertyVal(payload[0][0], 'name', 'express.request')
        assert.propertyVal(payload[0][1], 'name', 'express.middleware')
      })
    })
  })
})
