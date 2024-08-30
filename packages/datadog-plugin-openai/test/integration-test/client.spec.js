'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const semver = require('semver')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  // limit v4 tests while the IITM issue is resolved or a workaround is introduced
  // issue link: https://github.com/DataDog/import-in-the-middle/issues/60
  withVersions('openai', 'openai', '>=3', version => {
    const realVersion = require(`../../../../versions/openai@${version}`).version()

    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([`'openai@${version}'`, 'nock'], false, [
        './packages/datadog-plugin-openai/test/integration-test/*'])
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

    if (semver.satisfies(realVersion, '<4.0.0')) {
      it('is instrumented', async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'openai.request'), true)
        })

        proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port)

        await res
      }).timeout(20000)
    } else {
      it('does not error', async () => {
        proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port, undefined, {
          NODE_OPTIONS: '--import dd-trace/register.js'
        })
      }).timeout(20000)
    }
  })
})
