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
          allowedTools: ['mcp__local__fetch_weather'],
          disallowedTools: ['ToolSearch'],
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
        ? 'Get the current weather for New York (NY) in fahrenheit.'
        : 'Fetch the current weather for New York state (NY) in fahrenheit using ' +
          'the fetch_weather tool and return the result.'

      const subagentNYResult = is03
        ? 'The current weather in New York (NY) is 72°F.'
        : 'The current weather for New York state (NY) is **72°F**.'

      const outerThinkingText = is03
        ? 'The user wants me to:\n' +
          '1. Spawn a subagent to get the weather in New York (fahrenheit)\n' +
          '2. After that subagent completes, get the weather in California (fahrenheit) directly (not in a subagent)\n' +
          '\n' +
          'Let me first spawn the subagent for New York.'
        : 'The user wants me to:\n' +
          '1. Spawn a subagent to get the weather in New York (in fahrenheit)\n' +
          '2. After that, get the weather in California myself (not in a subagent) in fahrenheit\n' +
          '\n' +
          "Let me start by spawning a subagent for New York weather, then I'll fetch California weather myself."

      // The assistant's text preamble before issuing the Agent tool call
      const outerAgentPreamble = is03
        ? 'Sure! Let me first spawn a subagent to get the New York weather!'
        : "Sure! I'll spawn a subagent for New York's weather first, then fetch California's myself."

      // The assistant's text preamble before fetching CA weather directly
      const outerCaPreamble = is03
        ? "The subagent returned **72°F** for New York! Now let me fetch California's weather directly."
        : "Got New York's weather from the subagent! Now I'll fetch California's weather myself:"

      // The Agent tool's `description` argument (chosen by the LLM at outer step-0); differs by SDK version
      const agentDescription = is03 ? 'Fetch NY weather' : 'Fetch New York weather'

      const agentToolId = is03
        ? 'toolu_01SZNue23x2BTjuirYZtKpbX'
        : 'toolu_013TfS3Xc8j5aSaZDbeNTuaD'
      const caToolId = is03
        ? 'toolu_0118kw2Kk5ZgqNQMHWCLLGnb'
        : 'toolu_01F4QdACGNaxqbzxzW6AkCYG'

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
                : { description: agentDescription, prompt: subagentPrompt },
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
        tags: { ml_app: 'test' },
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
        tags: { ml_app: 'test' },
      })

      if (is03) {
        // 0.3.x: [3]=agent wrapper, [4]=subagent LLM, [5]=subagent step-0

        // [3] Agent (<description>) — the subagent wrapper span
        assertLlmObsSpanEvent(llmobsSpans[3], {
          span: apmSpans[3],
          parentId: llmobsSpans[2].span_id,
          spanKind: 'agent',
          name: `Agent (${agentDescription})`,
          inputValue: subagentPrompt,
          outputValue: subagentNYResult,
          sessionId,
          tags: { ml_app: 'test' },
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
          tags: { ml_app: 'test' },
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
          tags: { ml_app: 'test' },
        })
      } else {
        // 0.2.x: [3]=subagent LLM, [4]=subagent step-0, [5]=agent wrapper

        // [3] subagent step-0 LLM — calls the weather tool for NY
        assertLlmObsSpanEvent(llmobsSpans[3], {
          span: apmSpans[5],
          parentId: llmobsSpans[4].span_id,
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
          tags: { ml_app: 'test' },
        })

        // [4] subagent step-0 — no thinking, output is the tool result text
        assertLlmObsSpanEvent(llmobsSpans[4], {
          span: apmSpans[4],
          parentId: llmobsSpans[5].span_id,
          spanKind: 'step',
          name: 'step-0',
          inputValue: '',
          outputValue: 'The weather in NY is 72° in fahrenheit.',
          sessionId,
          tags: { ml_app: 'test' },
        })

        // [5] Agent (<description>) — the subagent wrapper span
        assertLlmObsSpanEvent(llmobsSpans[5], {
          span: apmSpans[3],
          parentId: llmobsSpans[2].span_id,
          spanKind: 'agent',
          name: `Agent (${agentDescription})`,
          inputValue: subagentPrompt,
          outputValue: subagentNYResult,
          sessionId,
          tags: { ml_app: 'test' },
        })
      }

      // [6] mcp__local__fetch_weather — NY weather tool call inside subagent
      assertLlmObsSpanEvent(llmobsSpans[6], {
        span: apmSpans[6],
        parentId: is03 ? llmobsSpans[5].span_id : llmobsSpans[4].span_id,
        spanKind: 'tool',
        name: 'mcp__local__fetch_weather',
        inputValue: '{"location":"NY","units":"fahrenheit"}',
        outputValue: MOCK_STRING,
        sessionId,
        tags: { ml_app: 'test' },
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
                : { description: agentDescription, prompt: subagentPrompt },
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
        tags: { ml_app: 'test' },
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
        tags: { ml_app: 'test' },
      })

      // [9] mcp__local__fetch_weather — CA weather tool call in outer agent
      assertLlmObsSpanEvent(llmobsSpans[9], {
        span: apmSpans[9],
        parentId: llmobsSpans[8].span_id,
        spanKind: 'tool',
        name: 'mcp__local__fetch_weather',
        inputValue: '{"location":"CA","units":"fahrenheit"}',
        outputValue: MOCK_STRING,
        sessionId,
        tags: { ml_app: 'test' },
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
                : { description: agentDescription, prompt: subagentPrompt },
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
        tags: { ml_app: 'test' },
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
        tags: { ml_app: 'test' },
      })
    })
  })
})
