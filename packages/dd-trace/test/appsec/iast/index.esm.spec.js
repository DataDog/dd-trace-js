'use strict'

const { createSandbox, spawnProc, FakeAgent } = require('../../../../../integration-tests/helpers')
const path = require('path')
const getPort = require('get-port')
const Axios = require('axios')
const { assert } = require('chai')

describe('ESM', () => {
  let axios, sandbox, cwd, appPort, appFile, agent, proc

  before(async function () {
    this.timeout(process.platform === 'win32' ? 90000 : 30000)
    sandbox = await createSandbox([`'express'`], false,
      [path.join(__dirname, 'resources')])
    appPort = await getPort()
    cwd = sandbox.folder
    appFile = path.join(cwd,  'resources','esm-app', 'index.mjs')

    axios = Axios.create({
      baseURL: `http://localhost:${appPort}`
    })
  })

  after(async function () {
    await sandbox.remove()
  })
  const nodeOptionsList = ['--import dd-trace/initialize.mjs', '--require dd-trace/init.js --loader dd-trace/initialize.mjs']

  nodeOptionsList.forEach(nodeOptions => {
    describe(`with NODE_OPTIONS=${nodeOptions}`, () => {
      beforeEach(async () => {
        agent = await new FakeAgent().start()

        proc = await spawnProc(appFile, {
          cwd,
          env: {
            DD_TRACE_AGENT_PORT: agent.port,
            APP_PORT: appPort,
            DD_IAST_ENABLED: 'true',
            DD_IAST_REQUEST_SAMPLING: '100',
            NODE_OPTIONS: nodeOptions
          }
        })
      })

      afterEach(async () => {
        proc.kill()
        await agent.stop()
      })

      it('test endpoint have COMMAND_INJECTION vulnerability', async function () {
        this.timeout(30000)
        await axios.get('/cmdi-vulnerable?args=-la')

        await agent.assertMessageReceived(({ payload }) => {
          assert.property(payload[0][0].meta, '_dd.iast.json')
          assert.include(payload[0][0].meta['_dd.iast.json'], '"COMMAND_INJECTION"')
        })
      })

      it('test endpoint have COMMAND_INJECTION vulnerability in imported file', async () => {
        await axios.get('/more/cmdi-vulnerable?args=-la')

        await agent.assertMessageReceived(({ payload }) => {
          assert.property(payload[0][0].meta, '_dd.iast.json')
          assert.include(payload[0][0].meta['_dd.iast.json'], '"COMMAND_INJECTION"')
        })
      })
    })
  })
})
