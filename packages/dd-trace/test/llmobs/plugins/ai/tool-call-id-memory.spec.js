'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProcAndExpectExit,
} = require('../../../../../../integration-tests/helpers')
const { withVersions } = require('../../../setup/mocha')

const MAX_OLD_SPACE_SIZE_MB = 64

describe('tool call ID memory regression', () => {
  withVersions('ai', 'ai', '>=5.0.0 <7.0.0', (version, _, realVersion) => {
    let agent

    useSandbox([`ai@${version}`, 'zod@^3.25.76'], false, [
      './packages/dd-trace/test/llmobs/plugins/ai/tool-call-id-memory.mjs',
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      await agent.stop()
    })

    it('does not retain tool call IDs after the corresponding tool span is named', async () => {
      const received = agent.assertMessageReceived(({ payload }) => {
        assert.ok(payload.flat().some(span => span.name === 'ai.toolCall'))
      })

      const completed = spawnPluginIntegrationTestProcAndExpectExit(
        sandboxCwd(),
        'tool-call-id-memory.mjs',
        agent.port,
        {
          AI_MODEL_SPECIFICATION_VERSION: realVersion.startsWith('4.')
            ? 'v1'
            : realVersion.startsWith('6.') ? 'v3' : 'v2',
          DD_LLMOBS_ENABLED: '1',
          DD_LLMOBS_ML_APP: 'tool-call-id-memory-test',
          DD_TRACE_FLUSH_INTERVAL: '100',
          NODE_OPTIONS: '--import dd-trace/initialize.mjs',
          _DD_LLMOBS_FLUSH_INTERVAL: '100',
        },
        [`--max-old-space-size=${MAX_OLD_SPACE_SIZE_MB}`]
      )

      await Promise.all([completed, received])
    }).timeout(60_000)
  })
})
