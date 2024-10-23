'use strict'

const { assert } = require('chai')
const path = require('path')
const axios = require('axios')

const {
  createSandbox,
  FakeAgent,
  spawnProc
} = require('./helpers')

describe('Suspicious request blocking - multer', () => {
  let sandbox, cwd, startupTestFile, agent, proc, env

  ['1.4.4-lts.1', '1.4.5-lts.1'].forEach((version) => {
    describe(`v${version}`, () => {
      before(async () => {
        sandbox = await createSandbox(['express', `multer@${version}`])
        cwd = sandbox.folder
        startupTestFile = path.join(cwd, 'multer', index.js')
      })

      after(async () => {
        await sandbox.remove()
      })

      beforeEach(async () => {
        agent = await new FakeAgent().start()

        env = {
          AGENT_PORT: agent.port,
          DD_APPSEC_RULES: path.join(cwd, 'multer/body-parser-rules.json')
        }

        const execArgv = []

        proc = await spawnProc(startupTestFile, { cwd, env, execArgv })
      })

      afterEach(async () => {
        proc.kill()
        await agent.stop()
      })

      it('should not block the request without an attack', async () => {
        const form = new FormData()
        form.append('key', 'value')

        const res = await axios.post(proc.url, form)

        assert.equal(res.data, 'DONE')
      })

      it('should block the request when attack is detected', async () => {
        try {
          const form = new FormData()
          form.append('key', 'testattack')

          await axios.post(proc.url, form)

          return Promise.reject(new Error('Request should not return 200'))
        } catch (e) {
          assert.equal(e.response.status, 403)
        }
      })
    })
  })
})
