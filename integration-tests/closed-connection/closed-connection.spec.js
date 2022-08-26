'use strict'

const {
  FakeAgent,
  spawnProc,
  createSandbox
} = require('../helpers')
const path = require('path')
const { assert } = require('chai')
const http = require('http')

describe('closed connection', () => {
  let agent
  let proc
  let sandbox
  let cwd
  let serverTestFile

  before(async () => {
    sandbox = await createSandbox()
    cwd = sandbox.folder
    serverTestFile = path.join(cwd, 'closed-connection', 'timeout-server.js')
  })

  after(async () => {
    await sandbox.remove()
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  it('Need a message after abort', async () => {
    proc = await spawnProc(serverTestFile, {
      cwd,
      env: {
        AGENT_PORT: agent.port
      }
    })
    return new Promise((resolve) => {
      agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])
        assert.strictEqual(payload[0].length, 1)
        assert.propertyVal(payload[0][0], 'name', 'web.request')
        resolve()
      }, 1000)
      const req = http.get(proc.url, res => {})
      req.on('error', () => {})
      setTimeout(() => { req.destroy() }, 200)
    })
  })
})
