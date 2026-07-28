'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const {
  FakeAgent,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  sandboxCwd,
  useSandbox,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
describe('esm', () => {
  let agent
  let proc
  // test against later versions because server.mjs uses newer package syntax
  withVersions('mongodb-core', 'mongodb', '>=4', version => {
    useSandbox([`'mongodb@${version}'`], false, [
      './packages/datadog-plugin-mongodb-core/test/integration-test/*'])

    const variants = varySandbox('server.mjs', {
      bindingName: 'mongodb',
      packageName: 'mongodb',
      defaultExport: true,
      namedExports: ['MongoClient'],
      namedExportBinding: 'namespace',
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented loaded with ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'mongodb.query'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(30000)
    }
  })

  // test against later versions because server2.mjs uses newer package syntax
  withVersions('mongodb-core', 'mongodb-core', '>=3', version => {
    useSandbox([`'mongodb-core@${version}'`], false, [
      './packages/datadog-plugin-mongodb-core/test/integration-test/*'])

    const variants = varySandbox('server2.mjs', {
      bindingName: 'MongoDBCore',
      packageName: 'mongodb-core',
      defaultExport: true,
      namedExports: [],
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented loaded with ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'mongodb.query'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(30000)
    }
  })
})
