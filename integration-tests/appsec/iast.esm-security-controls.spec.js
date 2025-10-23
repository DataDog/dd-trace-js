'use strict'

const { isolatedSandbox, spawnProc, FakeAgent } = require('../helpers')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')

describe('ESM Security controls', () => {
  let axios, sandbox, cwd, appFile, agent, proc

  ['4', '5'].forEach(version => {
    describe(`With express v${version}`, () => {
      before(async function () {
        this.timeout(process.platform === 'win32' ? 90000 : 30000)
        sandbox = await isolatedSandbox([`express@${version}`])
        cwd = sandbox.folder
        appFile = path.join(cwd, 'appsec', 'esm-security-controls', 'index.mjs')
      })

      after(async function () {
        await sandbox.remove()
      })

      const nodeOptions = '--import dd-trace/initialize.mjs'

      beforeEach(async () => {
        agent = await new FakeAgent().start()

        proc = await spawnProc(appFile, {
          cwd,
          env: {
            DD_TRACE_AGENT_PORT: agent.port,
            DD_IAST_ENABLED: 'true',
            DD_IAST_REQUEST_SAMPLING: '100',
            // eslint-disable-next-line no-multi-str
            DD_IAST_SECURITY_CONTROLS_CONFIGURATION: '\
            SANITIZER:COMMAND_INJECTION:appsec/esm-security-controls/sanitizer.mjs:sanitize;\
            SANITIZER:COMMAND_INJECTION:appsec/esm-security-controls/sanitizer-default.mjs;\
            INPUT_VALIDATOR:*:appsec/esm-security-controls/validator.mjs:validate',
            NODE_OPTIONS: nodeOptions
          }
        })

        axios = Axios.create({ baseURL: proc.url })
      })

      afterEach(async () => {
        proc.kill()
        await agent.stop()
      })

      it('test endpoint with iv not configured does have COMMAND_INJECTION vulnerability', async function () {
        await axios.get('/cmdi-iv-insecure?command=ls -la')

        await agent.assertMessageReceived(({ payload }) => {
          const spans = payload.flatMap(p => p.filter(span => span.name === 'express.request'))
          spans.forEach(span => {
            assert.property(span.meta, '_dd.iast.json')
            assert.include(span.meta['_dd.iast.json'], '"COMMAND_INJECTION"')
          })
        }, null, 1, true)
      })

      it('test endpoint sanitizer does not have COMMAND_INJECTION vulnerability', async () => {
        await axios.get('/cmdi-s-secure?command=ls -la')

        await agent.assertMessageReceived(({ payload }) => {
          const spans = payload.flatMap(p => p.filter(span => span.name === 'express.request'))
          spans.forEach(span => {
            assert.notProperty(span.meta, '_dd.iast.json')
            assert.property(span.metrics, '_dd.iast.telemetry.suppressed.vulnerabilities.command_injection')
          })
        }, null, 1, true)
      })

      it('test endpoint with default sanitizer does not have COMMAND_INJECTION vulnerability', async () => {
        await axios.get('/cmdi-s-secure-default?command=ls -la')

        await agent.assertMessageReceived(({ payload }) => {
          const spans = payload.flatMap(p => p.filter(span => span.name === 'express.request'))
          spans.forEach(span => {
            assert.notProperty(span.meta, '_dd.iast.json')
            assert.property(span.metrics, '_dd.iast.telemetry.suppressed.vulnerabilities.command_injection')
          })
        }, null, 1, true)
      })

      it('test endpoint with default sanitizer does have COMMAND_INJECTION with original tainted', async () => {
        await axios.get('/cmdi-s-secure-comparison?command=ls -la')

        await agent.assertMessageReceived(({ payload }) => {
          const spans = payload.flatMap(p => p.filter(span => span.name === 'express.request'))
          spans.forEach(span => {
            assert.property(span.meta, '_dd.iast.json')
            assert.include(span.meta['_dd.iast.json'], '"COMMAND_INJECTION"')
          })
        }, null, 1, true)
      })

      it('test endpoint with default sanitizer does have COMMAND_INJECTION vulnerability', async () => {
        await axios.get('/cmdi-s-secure-default?command=ls -la')

        await agent.assertMessageReceived(({ payload }) => {
          const spans = payload.flatMap(p => p.filter(span => span.name === 'express.request'))
          spans.forEach(span => {
            assert.notProperty(span.meta, '_dd.iast.json')
            assert.property(span.metrics, '_dd.iast.telemetry.suppressed.vulnerabilities.command_injection')
          })
        }, null, 1, true)
      })

      it('test endpoint with iv does not have COMMAND_INJECTION vulnerability', async () => {
        await axios.get('/cmdi-iv-secure?command=ls -la')

        await agent.assertMessageReceived(({ payload }) => {
          const spans = payload.flatMap(p => p.filter(span => span.name === 'express.request'))
          spans.forEach(span => {
            assert.notProperty(span.meta, '_dd.iast.json')
            assert.property(span.metrics, '_dd.iast.telemetry.suppressed.vulnerabilities.command_injection')
          })
        }, null, 1, true)
      })
    })
  })
})
