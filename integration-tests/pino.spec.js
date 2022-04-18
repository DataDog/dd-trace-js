/* eslint-disable comma-dangle */
'use strict'

const {
  FakeAgent,
  spawnProc,
  createSandbox,
  curlAndAssertMessage,
} = require('./helpers')
const path = require('path')
const { assert } = require('chai')

describe('pino test', () => {
  let agent
  let proc
  let sandbox
  let cwd
  let startupTestFile

  before(async () => {
    sandbox = await createSandbox(['pino'])
    cwd = sandbox.folder
    startupTestFile = path.join(cwd, 'pino/index.js')
  })

  after(async () => {
    await sandbox.remove()
  })

  context('Log injection', () => {
    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('Log injection enabled', async () => {
      proc = await spawnProc(startupTestFile, {
        cwd,
        env: {
          AGENT_PORT: agent.port,
          lOG_INJECTION: true,
        },
        stdio: 'pipe',
      })
      return curlAndAssertMessage(agent, proc, () => {
        proc.stdout.on('data', (data) => {
          const stdoutData = JSON.parse(data.toString())
          assert.containsAllKeys(stdoutData, ['dd'])
          assert.containsAllKeys(stdoutData.dd, ['trace_id', 'span_id'])
        })
      })
    })

    it('Log injection disabled', async () => {
      proc = await spawnProc(startupTestFile, {
        cwd,
        env: {
          AGENT_PORT: agent.port,
        },
        stdio: 'pipe',
      })
      return curlAndAssertMessage(agent, proc, () => {
        proc.stdout.on('data', (data) => {
          const stdoutData = JSON.parse(data.toString())
          assert.doesNotHaveAnyKeys(stdoutData, ['dd'])
        })
      })
    })
  })
})
