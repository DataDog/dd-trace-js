'use strict'

const { expect } = require('chai')
const { describe, before, after, it, beforeEach, afterEach } = require('mocha')

const path = require('node:path')

const { isolatedSandbox, FakeAgent, spawnProc, assertObjectContains } = require('./helpers')

describe('telemetry', () => {
  describe('dependencies', () => {
    let sandbox
    let cwd
    let startupTestFile
    let agent
    let proc

    before(async () => {
      sandbox = await isolatedSandbox()
      cwd = sandbox.folder
      startupTestFile = path.join(cwd, 'startup/index.js')
    })

    after(async () => {
      await sandbox.remove()
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(startupTestFile, {
        cwd,
        env: {
          AGENT_PORT: agent.port,
          DD_LOGS_INJECTION: 'true'
        }
      })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('Test that tracer and iitm are sent as dependencies', async () => {
      let ddTraceFound = false
      let importInTheMiddleFound = false

      await agent.assertTelemetryReceived(msg => {
        const { payload } = msg

        if (payload.request_type === 'app-dependencies-loaded') {
          if (payload.payload.dependencies) {
            payload.payload.dependencies.forEach(dependency => {
              if (dependency.name === 'dd-trace') {
                ddTraceFound = true
              }
              if (dependency.name === 'import-in-the-middle') {
                importInTheMiddleFound = true
              }
            })
          }
        }
      }, 'app-dependencies-loaded', 5_000, 1)

      expect(ddTraceFound).to.be.true
      expect(importInTheMiddleFound).to.be.true
    })

    it('Assert configuration chaining data is sent', async () => {
      await agent.assertTelemetryReceived(msg => {
        const { configuration } = msg.payload.payload
        assertObjectContains(configuration, [
          { name: 'DD_LOG_INJECTION', value: true, origin: 'default' },
          { name: 'DD_LOG_INJECTION', value: true, origin: 'env_var' },
          { name: 'DD_LOG_INJECTION', value: false, origin: 'code' }
        ])
      }, 'app-started', 5_000, 1)
    })
  })
})
