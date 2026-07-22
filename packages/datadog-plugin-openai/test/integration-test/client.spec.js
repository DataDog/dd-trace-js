'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const semver = require('semver')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
describe('esm', () => {
  let agent
  let proc

  // limit v4 tests while the IITM issue is resolved or a workaround is introduced
  // this is only relevant for `openai` >=4.0 <=4.1
  // issue link: https://github.com/DataDog/import-in-the-middle/issues/60
  withVersions('openai', 'openai', '>=3 <4.0.0 || >4.1.0', (version, _, realVersion) => {
    useSandbox(
      [
        `'openai@${version}'`,
        'nock',
        '@openai/agents',
        '@openai/agents-core',
      ],
      false,
      ['./packages/datadog-plugin-openai/test/integration-test/*']
    )

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const hasNamedExport = semver.satisfies(realVersion, '>=4')

    const variants = varySandbox('server.mjs', {
      bindingName: 'OpenAI',
      packageName: 'openai',
      defaultExport: true,
      namedExports: hasNamedExport ? ['OpenAI'] : [],
      namedExportBinding: hasNamedExport ? 'direct' : undefined,
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(
            checkSpansForServiceName(payload, 'openai.request'),
            true
          )
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(),
          variants[variant],
          agent.port,
          {
            NODE_OPTIONS: '--import dd-trace/initialize.mjs',
          }
        )

        await res
      }).timeout(20000)
    }
  })
})
