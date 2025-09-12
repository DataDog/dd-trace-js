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

describe('esm', () => {
  let agent
  let proc
  let sandbox
  let variants

  withVersions('mysql', 'mysql', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'mysql@${version}'`], false, [
        './packages/datadog-plugin-mysql/test/integration-test/*'])
      variants = varySandbox(sandbox, 'server.mjs', {
        default: 'import mysql from \'mysql\'',
        star: 'import * as mysql from \'mysql\'',
        destructure: 'import { createConnection } from \'mysql\'; const mysql = { createConnection };'
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

    for (const variant of ['star', 'default', 'destructure']) {
      it('is instrumented', async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'mysql.query'), true)
        })

        proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
