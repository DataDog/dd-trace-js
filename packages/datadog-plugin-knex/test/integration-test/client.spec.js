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

withVersions('knex', 'knex', (version, _, resolvedVersion) => {
  describe('ESM', () => {
    let variants, proc, agent

    // knex 1.x routes the `sqlite3` client through the @vscode/sqlite3 fork; every other major uses sqlite3.
    const sqlite3Driver = semver.satisfies(resolvedVersion, '1.x') ? '@vscode/sqlite3' : 'sqlite3'

    useSandbox([`'knex@${version}'`, 'express', sqlite3Driver], false,
      ['./packages/datadog-plugin-knex/test/integration-test/*'])

    before(function () {
      variants = varySandbox('server.mjs', 'knex')
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of varySandbox.VARIANTS) {
      it(`is instrumented loaded with ${variant}`, async () => {
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)
        const response = await curl(proc)
        assert.equal(response.headers['x-counter'], '1')
      })
    }
  })
})
