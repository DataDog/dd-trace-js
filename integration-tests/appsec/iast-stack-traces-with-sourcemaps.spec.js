'use strict'

const assert = require('node:assert/strict')

const childProcess = require('child_process')
const path = require('path')
const { inspect } = require('node:util')
const { sandboxCwd, useSandbox, spawnProc, FakeAgent, stopProc } = require('../helpers')
describe('IAST stack traces and vulnerabilities with sourcemaps', () => {
  let cwd, appDir, appFile, agent, proc

  useSandbox(['@types/node', 'typescript', 'express'])

  before(function () {
    cwd = sandboxCwd()

    appDir = path.join(cwd, 'appsec', 'iast-stack-traces-ts-with-sourcemaps')

    childProcess.execSync('npx tsc', {
      cwd: appDir,
    })

    appFile = path.join(appDir, 'index.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()

    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_IAST_ENABLED: 'true',
        DD_IAST_REQUEST_SAMPLING: '100',
        NODE_OPTIONS: `--enable-source-maps --require ${appDir}/init.js`,
      },
    })
  })

  afterEach(async () => {
    await stopProc(proc)
    await agent.stop()
  })

  /**
   * @param {string} url
   */
  async function request (url) {
    const response = await fetch(new URL(url, proc.url))
    assert.strictEqual(response.status, 200)
    return response.text()
  }

  describe('in rewritten file', () => {
    it('should detect correct stack trace in unnamed function', async () => {
      const response = await request('/rewritten/stack-trace-from-unnamed-function')

      assert.match(response, /\/rewritten-routes\.ts:7:13/)
    })

    it('should detect correct stack trace in named function', async () => {
      const response = await request('/rewritten/stack-trace-from-named-function')

      assert.match(response, /\/rewritten-routes\.ts:11:13/)
    })

    it('should detect vulnerability in the correct location', async () => {
      await request('/rewritten/vulnerability')

      await agent.assertMessageReceived(({ payload }) => {
        const spans = payload.flatMap(p => p.filter(span => span.name === 'express.request'))
        spans.forEach(span => {
          assert.ok(Object.hasOwn(span.meta, '_dd.iast.json'), `Available keys: ${inspect(Object.keys(span.meta))}`)
          const iastJsonObject = JSON.parse(span.meta['_dd.iast.json'])

          assert.strictEqual(iastJsonObject.vulnerabilities.some(vulnerability => {
            return vulnerability.type === 'WEAK_HASH' &&
              vulnerability.location.path === 'appsec/iast-stack-traces-ts-with-sourcemaps/rewritten-routes.ts' &&
              vulnerability.location.line === 15
          }), true)
        })
      }, null, 1, true)
    })
  })

  describe('in not rewritten file', () => {
    it('should detect correct stack trace in unnamed function', async () => {
      const response = await request('/not-rewritten/stack-trace-from-unnamed-function')

      assert.match(response, /\/not-rewritten-routes\.ts:7:13/)
    })

    it('should detect correct stack trace in named function', async () => {
      const response = await request('/not-rewritten/stack-trace-from-named-function')

      assert.match(response, /\/not-rewritten-routes\.ts:11:13/)
    })

    it('should detect vulnerability in the correct location', async () => {
      await request('/not-rewritten/vulnerability')

      await agent.assertMessageReceived(({ payload }) => {
        const spans = payload.flatMap(p => p.filter(span => span.name === 'express.request'))
        spans.forEach(span => {
          assert.ok(Object.hasOwn(span.meta, '_dd.iast.json'), `Available keys: ${inspect(Object.keys(span.meta))}`)
          const iastJsonObject = JSON.parse(span.meta['_dd.iast.json'])

          assert.strictEqual(iastJsonObject.vulnerabilities.some(vulnerability => {
            return vulnerability.type === 'WEAK_HASH' &&
              vulnerability.location.path === 'appsec/iast-stack-traces-ts-with-sourcemaps/not-rewritten-routes.ts' &&
              vulnerability.location.line === 15
          }), true)
        })
      }, null, 1, true)
    })
  })
})
