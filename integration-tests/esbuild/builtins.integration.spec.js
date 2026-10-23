'use strict'

const assert = require('node:assert/strict')
const { execSync } = require('node:child_process')
const path = require('node:path')

const { FakeAgent, sandboxCwd, spawnProc, stopProc, useSandbox } = require('../helpers')
const { assertBuiltinSpans } = require('../helpers/bundled-builtins')
const httpRequest = require('../../packages/dd-trace/test/setup/helpers/http-client')

const { ESBUILD_VERSION } = process.env
const esbuildVersions = ESBUILD_VERSION ? [ESBUILD_VERSION] : ['latest', '0.16.12']

for (const version of esbuildVersions) {
  describe(`esbuild ${version} with bundled dd-trace and statically imported built-ins`, () => {
    let agent
    let cwd
    let proc

    useSandbox([`esbuild@${version}`], false, [__dirname])

    before(() => {
      cwd = path.join(sandboxCwd(), 'esbuild')
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
        execSync(`node build.builtins.mjs ${format}`, { cwd })

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
