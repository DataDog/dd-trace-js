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

  withVersions('mongoose', ['mongoose'], '>=4', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'mongoose@${version}'`], false, [
        './packages/datadog-plugin-mongoose/test/integration-test/*'])
      variants = varySandbox(sandbox, 'server.mjs', {
        default: 'import mongoose from \'mongoose\'',
        star: 'import * as mongooseStar from \'mongoose\'; const mongoose = mongooseStar.default',
        destructure: 'import { default as mongoose } from \'mongoose\''
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
    for (const variant of ['default', 'destructure', 'star']) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'mongodb.query'), true)
        })

        proc = await spawnPluginIntegrationTestProc(sandbox.folder, variants[variant], agent.port)

        await res
      }).timeout(20000)
    }
  })
})
