'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const axios = require('axios')

const { FakeAgent, sandboxCwd, spawnProc, useSandbox } = require('../helpers')

const { WEBPACK_VERSION } = process.env
const webpackVersions = WEBPACK_VERSION ? [WEBPACK_VERSION] : ['5.109.2', '5.54.0']

for (const version of webpackVersions) {
  describe(`webpack ${version} ESM`, () => {
    let agent
    let cwd

    useSandbox([`webpack@${version}`, 'hono', '@hono/node-server'], false, [__dirname])

    before(() => {
      cwd = sandboxCwd()
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(() => agent.stop())

    it('instruments an ESM package in the bundle', async () => {
      execFileSync(process.execPath, [path.join(cwd, 'webpack', 'build-esm.mjs')], { cwd })

      const appFile = path.join(cwd, 'webpack', 'hono-out.cjs')
      const proc = await spawnProc(appFile, {
        cwd,
        env: { DD_TRACE_AGENT_URL: `http://localhost:${agent.port}` },
        stdio: 'pipe',
      })

      await Promise.all([
        agent.assertMessageReceived(({ payload }) => {
          for (const trace of payload) {
            for (const span of trace) {
              if (span.type !== 'web') continue
              assert.strictEqual(span.name, 'hono.request')
              return
            }
          }
          assert.fail('web span not found')
        }, 2_500),
        axios.get(proc.url),
      ])
    })
  })
}
