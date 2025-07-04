'use strict'

const {
  FakeAgent,
  createSandbox,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')

describe('esm', () => {
  let agent
  let proc
  let sandbox

  withVersions('ai', 'ai', version => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([
        `ai@${version}`,
        '@ai-sdk/openai',
        'zod'
      ], false, [
        './packages/datadog-plugin-ai/test/integration-test/*'
      ])
    })

    after(async () => {
      await sandbox.remove()
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc?.kill()
      await agent.stop()
    })

    it('is instrumented', async () => {
      const res = agent.assertMessageReceived(({ headers, payload }) => {
        assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
        assert.isArray(payload)

        // special check for ai spans
        for (const spans of payload) {
          for (const span of spans) {
            if (span.name.startsWith('ai')) {
              return
            }
          }
        }

        assert.fail('No ai spans found')
      })

      proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'server.mjs', agent.port, null, {
        NODE_OPTIONS: '--import dd-trace/initialize.mjs'
      })

      await res
    }).timeout(20000)
  })
})
