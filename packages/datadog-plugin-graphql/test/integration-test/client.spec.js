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

  withVersions('graphql', 'graphql', (version, moduleName, resolvedVersion) => {
    useSandbox([`'graphql@${version}'`], false, [
      './packages/datadog-plugin-graphql/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    // graphql-js >=17 dropped its ESM default export (`import graphql from 'graphql'` now
    // throws "does not provide an export named 'default'") — only the named-export forms
    // apply to it, while every earlier major exposes both. `version` can be a range
    // (e.g. '>=0.10'), so semver needs the resolved concrete version instead.
    const variants = varySandbox('server.mjs', {
      bindingName: 'graphqlLib',
      packageName: 'graphql',
      defaultExport: semver.lt(resolvedVersion, '17.0.0'),
      namedExports: ['GraphQLSchema', 'GraphQLString', 'graphql', 'GraphQLObjectType'],
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
          assert.strictEqual(checkSpansForServiceName(payload, 'graphql.parse'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port)

        await res
      }).timeout(50000)
    }
  })
})
