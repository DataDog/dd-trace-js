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

describe('esm', () => {
  let agent
  let proc
  let sandbox
  // test against later versions because server.mjs uses newer package syntax
  withVersions('prisma', '@prisma/client', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'@prisma/client@${version}'`], false, [
        './packages/datadog-plugin-prisma/test/integration-test/*'])
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

    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)
        assert.strictEqual(checkSpansForServiceName(payload, 'prisma.query'), true)
        assertObjectContains(payload, {
          resource: 'prisma.query',
          service: 'prisma',
          type: 'sql',
          span_type: 'sql',
          meta: {
            'db.system': 'postgresql',
            'db.user': 'foo',
            'db.name': 'postgres',
            'db.statement': 'SELECT * FROM users WHERE id = $1',
            'db.type': 'sql',
            'db.instance': 'postgres',
            'db.connection_string': 'postgresql://postgres:postgres@localhost:5432/postgres'
          }
        })
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

      await res
    }).timeout(20000)
  })
})
