'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  assertObjectContains
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { assert } = require('chai')
const { execSync } = require('child_process')

describe('esm', () => {
  let agent
  let proc
  let sandbox
  // test against later versions because server.mjs uses newer package syntax
  withVersions('prisma', '@prisma/client', version => {
    before(async function () {
      this.timeout(100000)
      sandbox = await createSandbox([`'prisma@${version}'`, `'@prisma/client@${version}'`], false, [
        './packages/datadog-plugin-prisma/test/integration-test/*',
        './packages/datadog-plugin-prisma/test/schema.prisma'
      ])
    })

    after(async () => {
      await sandbox.remove()
    })

    beforeEach(async function () {
      this.timeout(30000)
      agent = await new FakeAgent().start()
      execSync('npx prisma generate', { cwd: sandbox.folder, stdio: 'inherit' })
      execSync('npx prisma migrate reset --force', { cwd: sandbox.folder, stdio: 'inherit' })
      execSync('npx prisma db push --accept-data-loss', { cwd: sandbox.folder, stdio: 'inherit' })
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'prisma.client'), true)
        assertObjectContains(payload[0][0], {
          name: 'prisma.client',
          resource: 'User.create',
          service: 'node-prisma',
        })
        assertObjectContains(payload[1][4], {
          name: 'prisma.engine',
          service: 'node-prisma',
          meta: {
            'db.user': 'postgres',
            'db.name': 'postgres',
            'db.type': 'postgres',
          }
        })
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      await res
    }).timeout(20000)
  })
})
