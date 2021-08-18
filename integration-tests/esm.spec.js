'use strict'

const {
  FakeAgent,
  spawnProc,
  curlAndAssertMessage
} = require('./helpers')
const path = require('path')
const { assert } = require('chai')

const hookFile = path.join(__dirname, '..', 'loader-hook.mjs')

describe('esm', () => {
  let agent
  let proc

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  context('http', () => {
    it('is instrumented', async () => {
      proc = await spawnProc(path.join(__dirname, 'esm/http.mjs'), {
        env: {
          NODE_OPTIONS: `--no-warnings --loader=${hookFile}`,
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
      proc = await spawnProc(path.join(__dirname, 'esm/express.mjs'), {
        env: {
          NODE_OPTIONS: `--no-warnings --loader=${hookFile}`,
          AGENT_PORT: agent.port
        }
      })
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])
        assert.strictEqual(payload[0].length, 4)
        assert.propertyVal(payload[0][0], 'name', 'express.middleware')
      })
    })
  })
})
