'use strict'

const { createSandbox, spawnProc, FakeAgent } = require('../helpers')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')

describe('ESM', () => {
  let axios, sandbox, cwd, appFile, agent, proc

  before(async function () {
    this.timeout(process.platform === 'win32' ? 90000 : 30000)
    sandbox = await createSandbox(['express'])
    cwd = sandbox.folder
    appFile = path.join(cwd, 'appsec', 'esm-app', 'index.mjs')
  })

  after(async function () {
    await sandbox.remove()
  })

  const nodeOptionsList = [
    '--import dd-trace/initialize.mjs',
    '--require dd-trace/init.js --loader dd-trace/loader-hook.mjs'
  ]

  nodeOptionsList.forEach(nodeOptions => {
    describe(`with NODE_OPTIONS=${nodeOptions}`, () => {
      beforeEach(async () => {
        agent = await new FakeAgent().start()

        proc = await spawnProc(appFile, {
          cwd,
          env: {
            DD_TRACE_AGENT_PORT: agent.port,
            DD_IAST_ENABLED: 'true',
            DD_IAST_REQUEST_SAMPLING: '100',
            NODE_OPTIONS: nodeOptions
          }
        })

        axios = Axios.create({ baseURL: proc.url })
      })

      afterEach(async () => {
        proc.kill()
        await agent.stop()
      })

      function verifySpan (payload, verify) {
        let err
        for (let i = 0; i < payload.length; i++) {
          const trace = payload[i]
          for (let j = 0; j < trace.length; j++) {
            try {
              verify(trace[j])
              return
            } catch (e) {
              err = err || e
            }
          }
        }
        throw err
      }

      it('should detect COMMAND_INJECTION vulnerability', async function () {
        await axios.get('/cmdi-vulnerable?args=-la')

        await agent.assertMessageReceived(({ payload }) => {
          verifySpan(payload, span => {
            assert.property(span.meta, '_dd.iast.json')
            assert.include(span.meta['_dd.iast.json'], '"COMMAND_INJECTION"')
          })
        }, null, 1, true)
      })

      it('should detect COMMAND_INJECTION vulnerability in imported file', async () => {
        await axios.get('/more/cmdi-vulnerable?args=-la')

        await agent.assertMessageReceived(({ payload }) => {
          verifySpan(payload, span => {
            assert.property(span.meta, '_dd.iast.json')
            assert.include(span.meta['_dd.iast.json'], '"COMMAND_INJECTION"')
          })
        }, null, 1, true)
      })
    })
  })
})
