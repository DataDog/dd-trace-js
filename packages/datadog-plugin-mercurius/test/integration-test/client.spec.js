'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const axios = require('axios')
const semver = require('semver')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc
  let variants

  // mercurius 15+ ships fastify 5, which requires Node 20.9+; restrict to the
  // 13/14 line on older Node so the oldest-LTS CI leg does not sandbox an
  // unsupported runtime. Mirrors the non-ESM spec's `supportedOnThisNode` gate.
  const supportedRange = semver.satisfies(process.versions.node, '<20.9.0') ? '<15' : '*'

  withVersions('mercurius', 'mercurius', supportedRange, (version, _, resolvedVersion) => {
    // mercurius <=14 needs fastify 4 (fastify-plugin ^4); 15+ needs fastify 5.
    const fastifyDep = semver.satisfies(resolvedVersion, '>=15') ? 'fastify@5' : 'fastify@4'

    useSandbox([`'mercurius@${version}'`, `'${fastifyDep}'`], false, [
      './packages/datadog-plugin-mercurius/test/integration-test/*'])

    before(async function () {
      variants = varySandbox('server.mjs', 'mercurius')
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented ${variant}`, async () => {
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)

        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'graphql.request'), true)
        })

        await axios.post(`${proc.url}/graphql`, { query: 'query MyQuery { hello(name: "world") }' })

        await res
      }).timeout(50000)
    }
  })
})
