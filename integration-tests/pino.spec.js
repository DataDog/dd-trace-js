'use strict'

const { FakeAgent, spawnProc, createSandbox, curl, assertObjectContains } = require('./helpers')
const path = require('path')
const { assert } = require('chai')
const { once } = require('events')

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

    it('Log injection enabled by default', async () => {
      proc = await spawnProc(startupTestFile, {
        cwd,
        env: {
          AGENT_PORT: agent.port
        },
        stdio: 'pipe',
      })
      const [data] = await Promise.all([once(proc.stdout, 'data'), curl(proc)])
      const stdoutData = JSON.parse(data.toString())
      assertObjectContains(stdoutData, {
        dd: {
          trace_id: stdoutData.custom.trace_id,
          span_id: stdoutData.custom.span_id
        },
        custom: {
          trace_id: stdoutData.dd.trace_id,
          span_id: stdoutData.dd.span_id
        }
      })
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
      const [data] = await Promise.all([once(proc.stdout, 'data'), curl(proc)])
      const stdoutData = JSON.parse(data.toString())
      assert.containsAllKeys(stdoutData, ['dd'])
      assert.containsAllKeys(stdoutData.dd, ['trace_id', 'span_id'])
      assert.strictEqual(
        stdoutData.dd.trace_id,
        stdoutData.custom.trace_id
      )
      assert.strictEqual(
        stdoutData.dd.span_id,
        stdoutData.custom.span_id
      )
    })

    it('Log injection disabled', async () => {
      proc = await spawnProc(startupTestFile, {
        cwd,
        env: {
          AGENT_PORT: agent.port,
          lOG_INJECTION: false
        },
        stdio: 'pipe',
      })
      const [data] = await Promise.all([once(proc.stdout, 'data'), curl(proc)])
      const stdoutData = JSON.parse(data.toString())
      assert.doesNotHaveAnyKeys(stdoutData, ['dd'])
    })
  })
})
