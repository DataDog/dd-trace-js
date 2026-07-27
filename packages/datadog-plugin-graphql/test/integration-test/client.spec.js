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
    //
    // varySandbox's writeSandboxVariants derives every non-base variant by string-replacing
    // the base variant's own generated import line inside the template file, so the template
    // must already contain *that exact line* verbatim — the base is 'default' when
    // defaultExport is true, 'named' otherwise (see integration-tests/helpers/index.js). One
    // template can't serve both bases, so server-named.mjs mirrors server.mjs but starts from
    // the named-import form instead of the default one.
    const hasDefaultExport = semver.lt(resolvedVersion, '17.0.0')
    const variants = varySandbox(hasDefaultExport ? 'server.mjs' : 'server-named.mjs', {
      bindingName: 'graphqlLib',
      packageName: 'graphql',
      defaultExport: hasDefaultExport,
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
