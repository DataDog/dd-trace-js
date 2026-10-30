'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it, beforeEach, afterEach } = require('mocha')

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
const { supportsRunningNode } = require('../supports-running-node')

describe('esm', () => {
  let agent
  let proc

  withVersions('typesafe', ['@typesafe-ai/sdk'], version => {
    if (!supportsRunningNode(require(`../../../../versions/@typesafe-ai/sdk@${version}`))) return

    useSandbox([`@typesafe-ai/sdk@${version}`], false, [
      './packages/datadog-plugin-typesafe/test/integration-test/*',
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const variants = varySandbox('server.mjs', {
      bindingName: 'TypeSafeClient',
      packageName: '@typesafe-ai/sdk',
      namedExports: ['TypeSafeClient'],
      namedExportBinding: 'direct',
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
          assert.strictEqual(checkSpansForServiceName(payload, 'typesafe.request'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port, {
          NODE_OPTIONS: '--import dd-trace/initialize.mjs',
        })

        await res
      }).timeout(20000)
    }
  })
})
