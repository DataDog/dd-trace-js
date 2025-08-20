'use strict'

const {
  FakeAgent,
  createSandbox,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const semifies = require('semifies')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

function getOpenaiVersion (realVersion) {
  if (semifies(realVersion, '>=5.0.0')) {
    return '2.0.0'
  }
  return '1.3.23'
}

describe('esm', () => {
  let agent
  let proc
  let sandbox

  withVersions('ai', 'ai', (version, _, realVersion) => {
    before(async function () {
      this.timeout(20000)
      sandbox = await createSandbox([
        `ai@${version}`,
        `@ai-sdk/openai@${getOpenaiVersion(realVersion)}`,
        'zod@3.25.75'
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
