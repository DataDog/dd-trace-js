'use strict'

const assert = require('node:assert/strict')

const { inspect } = require('node:util')

const semver = require('semver')

const {
  FakeAgent,
  curlAndAssertMessage,
  checkSpansForServiceName,
  sandboxCwd,
  spawnPluginIntegrationTestProc,
  stopProc,
  useSandbox,
  varySandbox,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc
  const env = {
    NODE_OPTIONS: '--import dd-trace/initialize.mjs',
  }

  // skip older versions of fastify due to syntax differences
  withVersions('fastify', 'fastify', '>=3', (version, _, realVersion) => {
    useSandbox([`fastify@${version}`], false, [
      './packages/datadog-plugin-fastify/test/integration-test/*',
    ])

    const hasNamedExport = semver.satisfies(realVersion, '>=3.9.2')

    const variants = varySandbox('server.mjs', {
      bindingName: 'fastify',
      packageName: 'fastify',
      defaultExport: true,
      namedExports: hasNamedExport ? ['fastify'] : [],
      namedExportBinding: hasNamedExport ? 'direct' : undefined,
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented with ${variant} import`, async () => {
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port, env)

        await curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'fastify.request'), true)
        })
      }).timeout(20000)
    }

    it('is instrumented through the default export property', async () => {
      proc = await spawnPluginIntegrationTestProc(sandboxCwd(), 'server2.mjs', agent.port, env)

      await curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
        assert.strictEqual(checkSpansForServiceName(payload, 'fastify.request'), true)
      })
    }).timeout(20000)
  })
})
