'use strict'

const assert = require('node:assert/strict')

const semver = require('semver')

const {
  sandboxCwd,
  useSandbox,
  varySandbox,
  curl,
  FakeAgent,
  spawnPluginIntegrationTestProc,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { NODE_MAJOR } = require('../../../../version')

withVersions('cookie', 'cookie', (version, _moduleName, resolvedVersion) => {
  // cookie >=2 is ESM-only with named exports (no default), renames `parse` to `parseCookie`, and requires Node >=22.
  const isEsmOnly = semver.satisfies(resolvedVersion, '>=2')

  describe('ESM', () => {
    if (isEsmOnly && NODE_MAJOR < 22) return

    let proc, agent

    useSandbox([`'cookie@${version}'`, 'express'], false,
      ['./packages/datadog-plugin-cookie/test/integration-test/*'])

    const variants = varySandbox(isEsmOnly ? 'server-v2.mjs' : 'server.mjs', {
      bindingName: isEsmOnly ? 'parseCookie' : 'cookie',
      packageName: 'cookie',
      defaultExport: !isEsmOnly,
      namedExports: isEsmOnly ? ['parseCookie'] : [],
      namedExportBinding: isEsmOnly ? 'direct' : undefined,
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
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)
        const response = await curl(proc)
        assert.equal(response.headers['x-counter'], '1')
      })
    }
  })
})
