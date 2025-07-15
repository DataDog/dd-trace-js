'use strict'

const { createSandbox, FakeAgent, spawnProc } = require('../../../../integration-tests/helpers')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')

describe('Remote config client id', () => {
  let axios, sandbox, cwd, appFile

  before(async function () {
    this.timeout(process.platform === 'win32' ? 90000 : 30000)

    sandbox = await createSandbox(
      ['express'],
      false,
      [path.join(__dirname, 'resources')]
    )

    cwd = sandbox.folder
    appFile = path.join(cwd, 'resources', 'index.js')
  })

  after(async function () {
    this.timeout(60000)
    await sandbox.remove()
  })

  describe('enabled', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
        }
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should add client_id tag when remote config is enabled', async () => {
      await axios.get('/')

      return agent.assertMessageReceived(({ payload }) => {
        assert.exists(payload[0][0].meta['_dd.rc.client_id'])
      })
    })
  })

  describe('disabled', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_REMOTE_CONFIGURATION_ENABLED: false
        }
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should not add client_id tag when remote config is disbaled', async () => {
      await axios.get('/')

      return agent.assertMessageReceived(({ payload }) => {
        assert.notExists(payload[0][0].meta['_dd.rc.client_id'])
      })
    })
  })
})
