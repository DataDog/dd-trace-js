'use strict'

const {
  FakeAgent,
  spawnProc,
  createSandbox,
  curlAndAssertMessage
} = require('../../../../integration-tests/helpers')
const path = require('path')
const { assert } = require('chai')

const NODE_MAJOR = parseInt(process.versions.node.split('.')[0])

const hookFile = 'dd-trace/loader-hook.mjs'

// TODO: add ESM support for Node 20 in import-in-the-middle
const describe = NODE_MAJOR >= 20
  ? global.describe.skip
  : global.describe

describe('esm', () => {
  let agent
  let proc
  let sandbox
  let cwd

  before(async () => {
    sandbox = await createSandbox(['express'], false, `./packages/datadog-plugin-express/test/integration-test/*` )
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

  context('express', () => {
    it('is instrumented', async () => {
      proc = await spawnProc(path.join(cwd, 'server.mjs'), {
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
