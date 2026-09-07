'use strict'

const assert = require('node:assert')
const { execSync } = require('node:child_process')
const path = require('node:path')

const { FakeAgent, spawnProcAndExpectExit, sandboxCwd, useSandbox } = require('../helpers')
const { NODE_MAJOR } = require('../../version')

// @aws/durable-execution-sdk-js (>=1.1.0, our minimum supported version) requires Node.js >=22.
if (NODE_MAJOR < 22) return

const { ESBUILD_VERSION } = process.env
const esbuildVersions = ESBUILD_VERSION ? [ESBUILD_VERSION] : ['latest', '0.16.12']

esbuildVersions.forEach((version) => {
  describe(`esbuild ${version} bundling @aws/durable-execution-sdk-js`, () => {
    let agent, cwd

    useSandbox([
      `esbuild@${version}`,
      '@aws/durable-execution-sdk-js@1.1.2',
      '@aws/durable-execution-sdk-js-testing@1.1.1',
    ], false, [__dirname])

    before(() => {
      cwd = sandboxCwd()
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(() => agent.stop())

    // The SDK only exports '.' (not './package.json'), which makes
    // `require.resolve('@aws/durable-execution-sdk-js/package.json')` throw
    // ERR_PACKAGE_PATH_NOT_EXPORTED. Confirm the esbuild plugin still resolves and bundles
    // it (even when inlined) without erroring.
    it('bundles the exports-restricted package without a resolution error', () => {
      const builder = path.join(cwd, 'esbuild', 'build.durable-execution.js')
      execSync(`node ${builder}`, { cwd })
    })

    // Supported path: keep the durable SDK external so dd-trace instruments it at runtime.
    it('traces a bundled durable-execution app when the SDK is kept external', async () => {
      const builder = path.join(cwd, 'esbuild', 'build.durable-execution.js')
      execSync(`node ${builder}`, { cwd, env: { ...process.env, DD_EXTERNAL: '1' } })

      const appFile = path.join(cwd, 'esbuild', 'durable-execution-out.js')
      const durableSpans = new Set()
      await Promise.all([
        agent.assertMessageReceived(({ payload }) => {
          for (const trace of payload) {
            for (const span of trace) {
              if (span.meta?.component === 'aws-durable-execution-sdk-js') {
                durableSpans.add(span.name)
              }
            }
          }
          assert.ok(durableSpans.has('aws.durable.execute'),
            `expected an aws.durable.execute span, saw: ${[...durableSpans]}`)
          assert.ok(durableSpans.has('aws.durable.step'),
            `expected an aws.durable.step span, saw: ${[...durableSpans]}`)
        }, 20_000),
        spawnProcAndExpectExit(appFile, {
          cwd,
          env: { DD_TRACE_AGENT_URL: `http://localhost:${agent.port}` },
        }),
      ])
    })
  })
})
