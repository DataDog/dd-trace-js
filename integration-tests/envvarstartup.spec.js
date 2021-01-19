'use strict'

const {
  FakeAgent,
  spawnAndGetURL,
  curl
} = require('./helpers')
const path = require('path')
const assert = require('assert')

describe('startup', () => {
  let agentPort
  let agent
  let proc

  beforeEach(async () => {
    agent = new FakeAgent()
    agentPort = await agent.listeningPort()
  })

  afterEach(() => {
    proc.kill()
    agent.close()
  })

  context('programmatic', () => {
    it('works for options.port', async function () {
      const resultPromise = new Promise((resolve) => {
        agent.on('message', ({ payload }) => {
          assert.strictEqual(payload.length, 1)
          assert.strictEqual(payload[0].length, 1)
          assert.strictEqual(payload[0][0].name, 'http.request')
          resolve()
        })
      })
      proc = await spawnAndGetURL(path.join(__dirname, 'envvarstartup/index.js'), {
        env: {
          AGENT_PORT: agentPort
        }
      })
      await curl(proc)
      return resultPromise
    })

    it('works for options.url', async function () {
      const resultPromise = new Promise((resolve) => {
        agent.on('message', ({ payload }) => {
          assert.strictEqual(payload.length, 1)
          assert.strictEqual(payload[0].length, 1)
          assert.strictEqual(payload[0][0].name, 'http.request')
          resolve()
        })
      })
      proc = await spawnAndGetURL(path.join(__dirname, 'envvarstartup/index.js'), {
        env: {
          AGENT_URL: `http://localhost:${agentPort}`
        }
      })
      await curl(proc)
      return resultPromise
    })
  })

  context('env var', () => {
    it('works for DD_TRACE_AGENT_PORT', async function () {
      const resultPromise = new Promise((resolve) => {
        agent.on('message', ({ payload }) => {
          assert.strictEqual(payload.length, 1)
          assert.strictEqual(payload[0].length, 1)
          assert.strictEqual(payload[0][0].name, 'http.request')
          resolve()
        })
      })
      proc = await spawnAndGetURL(path.join(__dirname, 'envvarstartup/index.js'), {
        env: {
          DD_TRACE_AGENT_PORT: agentPort
        }
      })
      await curl(proc)
      return resultPromise
    })

    it('works for DD_TRACE_AGENT_URL', async function () {
      const resultPromise = new Promise((resolve) => {
        agent.on('message', ({ payload }) => {
          assert.strictEqual(payload.length, 1)
          assert.strictEqual(payload[0].length, 1)
          assert.strictEqual(payload[0][0].name, 'http.request')
          resolve()
        })
      })
      proc = await spawnAndGetURL(path.join(__dirname, 'envvarstartup/index.js'), {
        env: {
          DD_TRACE_AGENT_URL: `http://localhost:${agentPort}`
        }
      })
      await curl(proc)
      return resultPromise
    })
  })
})
