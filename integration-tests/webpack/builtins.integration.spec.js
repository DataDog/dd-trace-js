'use strict'

const assert = require('node:assert/strict')
const { execSync } = require('node:child_process')
const path = require('node:path')

const { FakeAgent, sandboxCwd, spawnProc, stopProc, useSandbox } = require('../helpers')
const { assertBuiltinSpans } = require('../helpers/bundled-builtins')
const httpRequest = require('../../packages/dd-trace/test/setup/helpers/http-client')

const { WEBPACK_VERSION } = process.env
const webpackVersions = WEBPACK_VERSION ? [WEBPACK_VERSION] : ['5.54.0', 'latest']

for (const version of webpackVersions) {
  describe(`webpack ${version} with bundled dd-trace and statically imported built-ins`, () => {
    let agent
    let cwd
    let proc

    useSandbox([`webpack@${version}`], false, [__dirname])

    before(() => {
      cwd = path.join(sandboxCwd(), 'webpack')
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      try {
        await stopProc(proc)
      } finally {
        await agent.stop()
      }
    })

    for (const [format, extension] of [['cjs', 'cjs'], ['esm', 'mjs']]) {
      it(`instruments node:http and node:dns in ${format} output`, async () => {
        execSync(`node build.builtins.js ${format}`, { cwd })

        proc = await spawnProc(path.join(cwd, `builtins-out.${extension}`), {
          cwd,
          env: { DD_TRACE_AGENT_PORT: String(agent.port) },
          execArgv: [],
          stdio: 'pipe',
        })

        const [response] = await Promise.all([
          httpRequest.get(`${proc.url}/`),
          assertBuiltinSpans(agent),
        ])
        assert.deepStrictEqual(response.data, { address: '127.0.0.1', body: 'builtin-ok' })
      })
    }
  })
}
