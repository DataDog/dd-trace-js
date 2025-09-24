'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')
const semver = require('semver')

describe('esm', () => {
  let agent
  let proc
  let sandbox
  let variants

  withVersions('pg', 'pg', (version, _, realVersion) => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'pg@${version}'`], false, [
        './packages/datadog-plugin-pg/test/integration-test/*'])
      variants = varySandbox(sandbox, 'server.mjs', {
        default: 'import pg from \'pg\'',
        star: semver.satisfies(realVersion, '<8.15.0')
          ? 'import * as mod from \'pg\'; const pg = { Client: mod.Client || mod.default.Client }'
          : 'import * as pg from \'pg\';',
        destructure: semver.satisfies(realVersion, '<8.15.0')
          ? 'import { default as pg } from \'pg\';'
          : 'import { Client } from \'pg\'; const pg = { Client }'
      })
    })

    after(async () => {
      await sandbox.remove()
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    for (const variant of ['default', 'star', 'destructure']) {
      it(`is instrumented (${variant})`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'pg.query'), true)
        })

        proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
