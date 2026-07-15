'use strict'

const assert = require('node:assert')
const semifies = require('semifies')
const { withVersions } = require('../../../setup/mocha')
const {
  useLlmObs,
  assertLlmObsSpanEvent,
  MOCK_STRING,
  MOCK_NUMBER,
} = require('../../util')
const { useEnv } = require('../../../../../../integration-tests/helpers')

const PROMPT =
  'Spawn a subagent to get the weather in New York. ' +
  'After that subagent, do it again but for California, not in a subagent. Both should be in fahrenheit.'

describe('Plugin', () => {
  useEnv({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '<not-a-real-key>',
  })

  const { getEvents } = useLlmObs({ plugin: 'claude-agent-sdk' })

  withVersions('claude-agent-sdk', '@anthropic-ai/claude-agent-sdk', (version, moduleName, realVersion) => {
    let client
    let zod

    let pathToClaudeCodeExecutable

    before(() => {
      const path = require('node:path')
      const sdkModule = require(`../../../../../../versions/@anthropic-ai/claude-agent-sdk@${version}`)
      client = sdkModule.get()
      zod = sdkModule.get('zod')
      // Force the glibc linux binary path — the SDK's musl/glibc auto-detection fails on some CI runners.
      const anthropicDir = path.dirname(path.dirname(sdkModule.getPath()))
      pathToClaudeCodeExecutable = path.join(
        anthropicDir, `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude'
      )
    })

    it('instruments a full agentic call with subagents', async function () {
      this.timeout(10000)
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
        prompt: PROMPT,
        options: {
          model: 'claude-sonnet-4-6',
          mcpServers: { local: localToolsServer },
          // Strip Claude Code built-in tools from the request payload so cassette hashes
          // stay stable across SDK versions (built-in tool descriptions change patch-to-patch).
          // The test needs `Agent` for subagent spawning, so keep it and normalize just its
          // description via VCR_BODY_REGEX_NORMALIZERS in docker-compose.yml.
          tools: ['Agent'],
          allowedTools: ['mcp__local__fetch_weather'],
          disallowedTools: ['Monitor', 'PushNotification', 'RemoteTrigger'],
          settingSources: [],
          systemPrompt: 'You are a helpful assistant. Use the available tools to answer the user.',
          skills: [],
          agents: {
            'weather-fetcher': {
              description: 'Fetches weather information for a US state using the fetch_weather tool.',
              prompt: 'You are a weather fetcher. ' +
                'Use the fetch_weather tool to get the requested weather. Report the result concisely.',
              tools: ['mcp__local__fetch_weather'],
              skills: [],
              model: 'claude-sonnet-4-6',
            },
          },
          cwd: '/tmp',
          pathToClaudeCodeExecutable,
          env: {
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:9126/vcr/claude-agent-sdk',
            CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: true,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
          },
        },
      })

      for await (const message of stream) {
        assert.ok(message.type)
      }

      const { apmSpans, llmobsSpans } = await getEvents(12)

      const sessionId = llmobsSpans[0].session_id
      const is03 = semifies(realVersion, '>=0.3.0')

      // Subagent prompt is determined by the LLM at the previous step - differs between SDK versions
      const subagentPrompt = is03
        ? 'Please fetch the current weather for New York (NY) in fahrenheit.'
        : 'Please fetch the current weather for New York state (NY) in fahrenheit.'

      const subagentNYResult = is03
        ? 'The current weather in New York (NY) is 72 degrees Fahrenheit.'
        : 'The current weather in New York state (NY) is 72 degrees Fahrenheit.'

      const outerThinkingText = is03
        ? 'The user wants me to:\n' +
          '1. Spawn a subagent to get the weather in New York (fahrenheit)\n' +
          '2. After that subagent completes, get the weather in California myself (fahrenheit)\n' +
          '\n' +
          'Let me spawn the subagent for New York first, and wait for it to complete before doing California.'
        : 'The user wants me to:\n' +
          '1. Spawn a subagent to get the weather in New York (fahrenheit)\n' +
          '2. After that, get the weather in California myself (fahrenheit)\n' +
          '\n' +
          'Let me start by spawning the subagent for New York.'

      // The assistant's text preamble before issuing the Agent tool call
      const outerAgentPreamble = is03
        ? 'Sure! Let me start by spawning a subagent to fetch the weather in New York first!'
        : 'Sure! Let me first spawn a subagent to fetch the weather in New York!'

      // The assistant's text preamble before fetching CA weather directly
      const outerCaPreamble = is03
        ? "The subagent got New York's weather — **72°F**! Now let me fetch California's weather directly myself:"
        : 'The subagent returned the New York weather: **72°F**. Now let me fetch the California weather myself!'

      // The Agent tool's `description` argument (chosen by the LLM at outer step-0); differs by SDK version
      const agentDescription = is03 ? 'Fetch NY weather' : 'Fetch New York weather'

      const agentToolId = is03
        ? 'toolu_016VmQ6ndQNjrpmkSStPeqfP'
        : 'toolu_01SU9BpPjFH3AT2rQq5erY6e'
      const caToolId = is03
        ? 'toolu_01EBvgoEf1PUX7p7t1Eut5ir'
        : 'toolu_011eagJ7ZyfQBNE1q8Yd61Bt'

      // [0] root query span
      assertLlmObsSpanEvent(llmobsSpans[0], {
        span: apmSpans[0],
        spanKind: 'agent',
        name: 'claude_agent_sdk.query',
        inputValue: PROMPT,
        outputValue: MOCK_STRING,
        metadata: { cwd: require('node:fs').realpathSync('/tmp'), permissionMode: 'default' },
        sessionId,
        tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
      })

      // [1] outer step-0 LLM — first call, spawns subagent
      assertLlmObsSpanEvent(llmobsSpans[1], {
        span: apmSpans[2],
        parentId: llmobsSpans[2].span_id,
        spanKind: 'llm',
        name: 'claude-sonnet-4-6',
        modelName: 'claude-sonnet-4-6',
        modelProvider: 'anthropic',
        inputMessages: [{ role: 'user', content: PROMPT }],
        outputMessages: [
          { role: 'thinking', content: outerThinkingText },
          {
            role: 'assistant',
            content: MOCK_STRING,
            tool_calls: [{
              name: 'Agent',
              arguments: is03
                ? {
                    description: agentDescription,
                    subagent_type: 'weather-fetcher',
                    prompt: subagentPrompt,
                    run_in_background: false,
                  }
                : {
                    description: agentDescription,
                    prompt: subagentPrompt,
                    subagent_type: 'weather-fetcher',
                  },
              tool_id: MOCK_STRING,
              type: 'tool_use',
            }],
          },
        ],
        metrics: {
          input_tokens: MOCK_NUMBER,
          output_tokens: MOCK_NUMBER,
          cache_read_input_tokens: MOCK_NUMBER,
          cache_write_input_tokens: MOCK_NUMBER,
          total_tokens: MOCK_NUMBER,
        },
        sessionId,
        tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
      })

      // [2] outer step-0 — input is the LLM's thinking text
      assertLlmObsSpanEvent(llmobsSpans[2], {
        span: apmSpans[1],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'step',
        name: 'step-0',
        inputValue: outerThinkingText,
        outputValue: subagentNYResult,
        sessionId,
        tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
      })

      // [3]=agent wrapper, [4]=subagent LLM, [5]=subagent step-0

      // [3] Agent (<description>) — the subagent wrapper span
      assertLlmObsSpanEvent(llmobsSpans[3], {
        span: apmSpans[3],
        parentId: llmobsSpans[2].span_id,
        spanKind: 'agent',
        name: `Agent (${agentDescription})`,
        inputValue: subagentPrompt,
        outputValue: subagentNYResult,
        sessionId,
        tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
      })

      // [4] subagent step-0 LLM — calls the weather tool for NY
      assertLlmObsSpanEvent(llmobsSpans[4], {
        span: apmSpans[5],
        parentId: llmobsSpans[5].span_id,
        spanKind: 'llm',
        name: 'claude-sonnet-4-6',
        modelName: 'claude-sonnet-4-6',
        modelProvider: 'anthropic',
        inputMessages: [{ role: 'user', content: subagentPrompt }],
        outputMessages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              name: 'mcp__local__fetch_weather',
              arguments: { location: 'NY', units: 'fahrenheit' },
              tool_id: MOCK_STRING,
              type: 'tool_use',
            }],
          },
        ],
        metrics: {
          input_tokens: MOCK_NUMBER,
          output_tokens: MOCK_NUMBER,
          cache_read_input_tokens: MOCK_NUMBER,
          cache_write_input_tokens: MOCK_NUMBER,
          total_tokens: MOCK_NUMBER,
        },
        sessionId,
        tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
      })

      // [5] subagent step-0 — no thinking, output is the tool result text
      assertLlmObsSpanEvent(llmobsSpans[5], {
        span: apmSpans[4],
        parentId: llmobsSpans[3].span_id,
        spanKind: 'step',
        name: 'step-0',
        inputValue: '',
        outputValue: 'The weather in NY is 72° in fahrenheit.',
        sessionId,
        tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
      })

      // [6] mcp__local__fetch_weather — NY weather tool call inside subagent
      assertLlmObsSpanEvent(llmobsSpans[6], {
        span: apmSpans[6],
        parentId: llmobsSpans[5].span_id,
        spanKind: 'tool',
        name: 'mcp__local__fetch_weather',
        inputValue: '{"location":"NY","units":"fahrenheit"}',
        outputValue: 'The weather in NY is 72° in fahrenheit.',
        sessionId,
        tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
      })

      // [7] outer step-1 LLM — fetches CA weather directly after subagent result
      assertLlmObsSpanEvent(llmobsSpans[7], {
        span: apmSpans[8],
        parentId: llmobsSpans[8].span_id,
        spanKind: 'llm',
        name: 'claude-sonnet-4-6',
        modelName: 'claude-sonnet-4-6',
        modelProvider: 'anthropic',
        inputMessages: [
          { role: 'user', content: PROMPT },
          { role: 'thinking', content: outerThinkingText },
          {
            role: 'assistant',
            content: outerAgentPreamble,
            tool_calls: [{
              name: 'Agent',
              arguments: is03
                ? {
                    description: agentDescription,
                    subagent_type: 'weather-fetcher',
                    prompt: subagentPrompt,
                    run_in_background: false,
                  }
                : {
                    description: agentDescription,
                    prompt: subagentPrompt,
                    subagent_type: 'weather-fetcher',
                  },
              tool_id: agentToolId,
              type: 'tool_use',
            }],
          },
          { role: 'tool', content: subagentNYResult },
        ],
        outputMessages: [
          {
            role: 'assistant',
            content: MOCK_STRING,
            tool_calls: [{
              name: 'mcp__local__fetch_weather',
              arguments: { location: 'CA', units: 'fahrenheit' },
              tool_id: MOCK_STRING,
              type: 'tool_use',
            }],
          },
        ],
        metrics: {
          input_tokens: MOCK_NUMBER,
          output_tokens: MOCK_NUMBER,
          cache_read_input_tokens: MOCK_NUMBER,
          cache_write_input_tokens: MOCK_NUMBER,
          total_tokens: MOCK_NUMBER,
        },
        sessionId,
        tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
      })

      // [8] outer step-1 — no thinking, output is the CA tool result
      assertLlmObsSpanEvent(llmobsSpans[8], {
        span: apmSpans[7],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'step',
        name: 'step-1',
        inputValue: '',
        outputValue: 'The weather in CA is 72° in fahrenheit.',
        sessionId,
        tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
      })

      // [9] mcp__local__fetch_weather — CA weather tool call in outer agent
      assertLlmObsSpanEvent(llmobsSpans[9], {
        span: apmSpans[9],
        parentId: llmobsSpans[8].span_id,
        spanKind: 'tool',
        name: 'mcp__local__fetch_weather',
        inputValue: '{"location":"CA","units":"fahrenheit"}',
        outputValue: 'The weather in CA is 72° in fahrenheit.',
        sessionId,
        tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
      })

      // [10] outer step-2 LLM — final summary after both results are in
      assertLlmObsSpanEvent(llmobsSpans[10], {
        span: apmSpans[11],
        parentId: llmobsSpans[11].span_id,
        spanKind: 'llm',
        name: 'claude-sonnet-4-6',
        modelName: 'claude-sonnet-4-6',
        modelProvider: 'anthropic',
        inputMessages: [
          { role: 'user', content: PROMPT },
          { role: 'thinking', content: outerThinkingText },
          {
            role: 'assistant',
            content: outerAgentPreamble,
            tool_calls: [{
              name: 'Agent',
              arguments: is03
                ? {
                    description: agentDescription,
                    subagent_type: 'weather-fetcher',
                    prompt: subagentPrompt,
                    run_in_background: false,
                  }
                : {
                    description: agentDescription,
                    prompt: subagentPrompt,
                    subagent_type: 'weather-fetcher',
                  },
              tool_id: agentToolId,
              type: 'tool_use',
            }],
          },
          { role: 'tool', content: subagentNYResult },
          {
            role: 'assistant',
            content: outerCaPreamble,
            tool_calls: [{
              name: 'mcp__local__fetch_weather',
              arguments: { location: 'CA', units: 'fahrenheit' },
              tool_id: caToolId,
              type: 'tool_use',
            }],
          },
          { role: 'tool', content: 'The weather in CA is 72° in fahrenheit.' },
        ],
        outputMessages: [{ role: 'assistant', content: MOCK_STRING }],
        metrics: {
          input_tokens: MOCK_NUMBER,
          output_tokens: MOCK_NUMBER,
          cache_read_input_tokens: MOCK_NUMBER,
          cache_write_input_tokens: MOCK_NUMBER,
          total_tokens: MOCK_NUMBER,
        },
        sessionId,
        tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
      })

      // [11] outer step-2 — no thinking, output is the final LLM summary
      assertLlmObsSpanEvent(llmobsSpans[11], {
        span: apmSpans[10],
        parentId: llmobsSpans[0].span_id,
        spanKind: 'step',
        name: 'step-2',
        inputValue: '',
        outputValue: MOCK_STRING,
        sessionId,
        tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
      })
    })
  })
})
