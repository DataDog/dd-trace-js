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
      // OpenAI v4 interacts poorly with import-in-the-middle.
      // Using the `register` import allows us to ignore OpenAI entirely, and not produce errors.
      // However, because of this, tracing does not happen. This will require a fix in import-in-the-middle.
      // For now, this test just verifies that the script executes without error.
      it('does not error', async () => {
        proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port, undefined, {
          NODE_OPTIONS: '--import dd-trace/register.js'
        })
      }).timeout(20000)
    }
  })
})
