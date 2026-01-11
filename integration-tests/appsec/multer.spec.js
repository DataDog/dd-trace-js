'use strict'

const assert = require('node:assert/strict')

const path = require('node:path')
const axios = require('axios')
const { describe, it, beforeEach, afterEach, before } = require('mocha')

const {
  sandboxCwd,
  useSandbox,
  FakeAgent,
  spawnProc
} = require('../helpers')

describe('multer', () => {
  let cwd, startupTestFile, agent, proc, env

  ['1.4.4-lts.1', '1.4.5-lts.1'].forEach((version) => {
    describe(`v${version}`, () => {
      useSandbox(['express', `multer@${version}`])

      before(() => {
        cwd = sandboxCwd()
        startupTestFile = path.join(cwd, 'appsec', 'multer', 'index.js')
      })

      beforeEach(async () => {
        agent = await new FakeAgent().start()

        env = {
          AGENT_PORT: agent.port,
          DD_APPSEC_RULES: path.join(cwd, 'appsec', 'multer', 'body-parser-rules.json')
        }

        const execArgv = []

        proc = await spawnProc(startupTestFile, { cwd, env, execArgv })
      })

      afterEach(async () => {
        proc.kill()
        await agent.stop()
      })

      describe('Suspicious request blocking', () => {
        describe('using middleware', () => {
          it('should not block the request without an attack', async () => {
            const form = new FormData()
            form.append('key', 'value')

            const res = await axios.post(proc.url, form)

            assert.strictEqual(res.data, 'DONE')
          })

          it('should block the request when attack is detected', async () => {
            try {
              const form = new FormData()
              form.append('key', 'testattack')

              await axios.post(proc.url, form)

              return Promise.reject(new Error('Request should not return 200'))
            } catch (e) {
              assert.strictEqual(e.response.status, 403)
            }
          })
        })

        describe('not using middleware', () => {
          it('should not block the request without an attack', async () => {
            const form = new FormData()
            form.append('key', 'value')

            const res = await axios.post(`${proc.url}/no-middleware`, form)

            assert.strictEqual(res.data, 'DONE')
          })

          it('should block the request when attack is detected', async () => {
            try {
              const form = new FormData()
              form.append('key', 'testattack')

              await axios.post(`${proc.url}/no-middleware`, form)

              return Promise.reject(new Error('Request should not return 200'))
            } catch (e) {
              assert.strictEqual(e.response.status, 403)
            }
          })
        })
      })

      describe('IAST', () => {
        function assertCmdInjection ({ payload }) {
          assert.ok(Array.isArray(payload))
          assert.strictEqual(payload.length, 1)
          assert.ok(Array.isArray(payload[0]))

          const { meta } = payload[0][0]

          assert.ok(Object.hasOwn(meta, '_dd.iast.json'))

          const iastJson = JSON.parse(meta['_dd.iast.json'])

          assert.strictEqual(iastJson.vulnerabilities.some(v => v.type === 'COMMAND_INJECTION'), true)
          assert.strictEqual(iastJson.sources.some(s => s.origin === 'http.request.body'), true)
        }

        describe('using middleware', () => {
          it('should taint multipart body', async () => {
            const resultPromise = agent.assertMessageReceived(assertCmdInjection)

            const formData = new FormData()
            formData.append('command', 'echo 1')
            await axios.post(`${proc.url}/cmd`, formData)

            return resultPromise
          })
        })

        describe('not using middleware', () => {
          it('should taint multipart body', async () => {
            const resultPromise = agent.assertMessageReceived(assertCmdInjection)

            const formData = new FormData()
            formData.append('command', 'echo 1')
            await axios.post(`${proc.url}/cmd-no-middleware`, formData)

            return resultPromise
          })
        })
      })
    })
  })
})
