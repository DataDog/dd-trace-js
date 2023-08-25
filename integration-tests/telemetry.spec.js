'use strict'

const { createSandbox, FakeAgent, spawnProc } = require('./helpers')
const path = require('path')

describe('telemetry', () => {
  describe('dependencies', () => {
    let sandbox
    let cwd
    let startupTestFile
    let agent
    let proc

    before(async () => {
      sandbox = await createSandbox()
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
          AGENT_PORT: agent.port
        }
      })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('Test that tracer and iitm are sent as dependencies', (done) => {
      let ddTraceFound = false
      let importInTheMiddleFound = false

      agent.assertTelemetryReceived(msg => {
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
            if (ddTraceFound && importInTheMiddleFound) {
              done()
            }
          }
        }
      }, null, 'app-dependencies-loaded', 1)
    })
  })
})
