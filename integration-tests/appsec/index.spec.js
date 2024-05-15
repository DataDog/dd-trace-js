'use strict'

const getPort = require('get-port')
const { createSandbox, FakeAgent, spawnProc } = require('../helpers')
const path = require('path')
const axios = require('axios')
const { assert } = require('chai')

describe('rasp', () => {
  let sandbox, cwd, appPort, appFile, agent, proc

  before(async () => {
    sandbox = await createSandbox(['express'])
    appPort = await getPort()
    cwd = sandbox.folder
    appFile = path.join(cwd, 'appsec/rasp/index.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        AGENT_PORT: agent.port,
        APP_PORT: appPort,
        DD_APPSEC_ENABLED: true
      }
    })
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  after(async () => {
    await sandbox.remove()
  })

  describe('ssrf', () => {
    it('should block when error is unhandled', (done) => {
      axios({
        url: `http://localhost:${appPort}/ssrf/http/unhandled-error?url=https://www.datadoghq.com/rasp-block`,
        method: 'get'
      }).then(() => {
        done(new Error('Request should have failed'))
      }).catch(e => {
        assert.strictEqual(e.response.status, 403)
        done()
      })
    })
  })
})
