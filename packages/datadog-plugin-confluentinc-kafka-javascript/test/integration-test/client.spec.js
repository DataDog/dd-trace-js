'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

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

  withVersions('confluentinc-kafka-javascript', '@confluentinc/kafka-javascript', version => {
    useSandbox([`'@confluentinc/kafka-javascript@${version}'`], false, [
      './packages/datadog-plugin-confluentinc-kafka-javascript/test/integration-test/*',
      './packages/datadog-plugin-confluentinc-kafka-javascript/test/helpers.js'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const variants = varySandbox('server.mjs', {
      bindingName: 'kafkaLib',
      packageName: '@confluentinc/kafka-javascript',
      defaultExport: true,
      namedExports: ['KafkaJS'],
      namedExportBinding: 'namespace',
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
          assert.strictEqual(checkSpansForServiceName(payload, 'kafka.produce'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(5000)
    }
  })
})
