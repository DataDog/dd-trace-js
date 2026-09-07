'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProcAndExpectExit,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('Bedrock recursion regression', () => {
  let agent
  let proc

  withVersions('ai', 'ai', '>=6.0.0 <7.0.0', aiVersion => {
    withVersions('ai', '@ai-sdk/amazon-bedrock', '^3.0.0', bedrockVersion => {
      useSandbox([
        `ai@${aiVersion}`,
        `@ai-sdk/amazon-bedrock@${bedrockVersion}`,
      ], false, [
        './packages/datadog-plugin-ai/test/integration-test/bedrock-recursion.mjs',
      ])

      beforeEach(async () => {
        agent = await new FakeAgent().start()
      })

      afterEach(async () => {
        await stopProc(proc)
        await agent.stop()
      })

      it('does not recurse when AI SDK adapts a v2 Bedrock model', async () => {
        const received = agent.assertMessageReceived(({ payload }) => {
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.ok(payload.flat().some(span => span.name === 'ai.generateText'))
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(
          sandboxCwd(),
          'bedrock-recursion.mjs',
          agent.port,
          {
            AWS_ACCESS_KEY_ID: 'test-access-key',
            AWS_SECRET_ACCESS_KEY: 'test-secret-key',
            AWS_REGION: 'us-east-1',
            DD_LLMOBS_ENABLED: '1',
            DD_LLMOBS_ML_APP: 'test',
            NODE_OPTIONS: '--import dd-trace/initialize.mjs',
          },
          ['--stack-size=128']
        )

        await received
      }).timeout(20000)
    })
  })
})
