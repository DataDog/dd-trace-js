'use strict'

const assert = require('node:assert')
const { execSync } = require('node:child_process')

const { describe, it, beforeEach, before, after, afterEach } = require('mocha')

const {
  FakeAgent,
  createSandbox,
  spawnPluginIntegrationTestProc,
  assertObjectContains
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  withVersions('prisma', '@prisma/client', version => {
    before(async function () {
      this.timeout(100000)
      sandbox = await createSandbox([`'prisma@${version}'`, `'@prisma/client@${version}'`], false, [
        './packages/datadog-plugin-prisma/test/integration-test/*',
        './packages/datadog-plugin-prisma/test/schema.prisma'
      ])
    })

    after(async () => {
      await sandbox?.remove()
    })

    beforeEach(async function () {
      this.timeout(60000)
      agent = await new FakeAgent().start()
      execSync(
        './node_modules/.bin/prisma migrate reset --force && ' +
        './node_modules/.bin/prisma db push --accept-data-loss && ' +
        './node_modules/.bin/prisma generate',
        {
          cwd: sandbox.folder, // Ensure the current working directory is where the schema is located
          stdio: 'inherit'
        }
      )
    })

    afterEach(async () => {
      proc?.kill()
      await agent.stop()
    })

    it('is instrumented', async function () {
      this.timeout(60000)
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
        assertObjectContains(payload, [[{
          name: 'prisma.client',
          resource: 'User.create',
          service: 'node-prisma',
        }], [{
          name: 'prisma.engine',
          service: 'node-prisma',
          meta: {
            'db.user': 'postgres',
            'db.name': 'postgres',
            'db.type': 'postgres',
          }
        }]])
      })

      // TODO: Integrate the assertions into the spawn command by adding a
      // callback. It should end the process when the assertions are met. That
      // way we can remove the Promise.all and the procPromise.then().
      const procPromise = spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port, {
        DD_TRACE_FLUSH_INTERVAL: '2000'
      })

      await Promise.all([
        procPromise.then((res) => {
          proc = res
        }),
        res
      ])
    })
  })
})
