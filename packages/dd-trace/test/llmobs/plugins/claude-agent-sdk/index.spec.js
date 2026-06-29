'use strict'

const assert = require('node:assert')
const { withVersions } = require('../../../setup/mocha')
const { useLlmObs } = require('../../util')
const { useEnv } = require('../../../../../../integration-tests/helpers')

describe('Plugin', () => {
  useEnv({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '<not-a-real-key>',
  })

  const { getEvents } = useLlmObs({ plugin: 'claude-agent-sdk' })

  withVersions('claude-agent-sdk', '@anthropic-ai/claude-agent-sdk', version => {
    let client
    let zod

    before(() => {
      const sdkModule = require(`../../../../../../versions/@anthropic-ai/claude-agent-sdk@${version}`)
      client = sdkModule.get()
      zod = sdkModule.get('zod')
    })

    it('instruments a full agentic call with subagents', async function () {
      this.timeout(300000000)

      const { z } = zod

      const fetchWeather = client.tool(
        'fetch_weather',
        'Fetches the current weather for a given US state.',
        {
          location: z.string().describe('The state by 2-letter code, e.g CA or NY'),
          units: z.enum(['celsius', 'fahrenheit']).optional().describe('The temperature unit to return'),
        },
        async ({ location, units = 'fahrenheit' }) => {
          return { content: [{ type: 'text', text: `The weather in ${location} is 72° in ${units}.` }] }
        }
      )

      const localToolsServer = client.createSdkMcpServer({ name: 'local', tools: [fetchWeather] })

      const stream = client.query({
        prompt:
          'Spawn a subagent to get the weather in New York. ' +
          'After that subagent, do it again but for California, not in a subagent. Both should be in fahrenheit.',
        options: {
          model: 'sonnet',
          mcpServers: { local: localToolsServer },
          allowedTools: ['mcp__local__fetch_weather'],
          settingSources: [],
          env: {
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:9126/vcr/claude-agent-sdk',
            CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: true,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          },
        },
      })

      for await (const message of stream) {
        assert.ok(message)
      }

      const { llmobsSpans } = await getEvents()

      assert.ok(llmobsSpans.length > 0)
    })
  })
})
