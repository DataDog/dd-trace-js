'use strict'

const assert = require('node:assert')
const { describe, before, after, it } = require('mocha')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { useEnv } = require('../../../integration-tests/helpers')

const PROMPT =
  'Spawn a subagent to get the weather in New York. ' +
  'After that subagent, do it again but for California, not in a subagent. Both should be in fahrenheit.'

describe('Plugin', () => {
  describe('claude-agent-sdk', () => {
    useEnv({
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '<not-a-real-key>',
    })

    withVersions('claude-agent-sdk', '@anthropic-ai/claude-agent-sdk', (version) => {
      let client
      let zod
      let pathToClaudeCodeExecutable

      before(async () => {
        const path = require('node:path')
        await agent.load('claude-agent-sdk')
        const sdkModule = require(`../../../versions/@anthropic-ai/claude-agent-sdk@${version}`)
        client = sdkModule.get()
        zod = sdkModule.get('zod')
        const anthropicDir = path.dirname(path.dirname(sdkModule.getPath()))
        pathToClaudeCodeExecutable = path.join(
          anthropicDir, `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude'
        )
      })

      after(() => agent.close())

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

        const tracesPromise = agent.assertSomeTraces(traces => {
          console.log('got some traces')
          const spans = traces.flat()
          console.log('spans length', spans.length)
          assert.equal(spans.length, 12)

          const spanById = new Map(spans.map(s => [s.span_id.toString(), s]))
          const byResource = resource => spans.filter(s => s.resource === resource)

          const querySpans = byResource('claude_agent_sdk.query')
          const stepSpans = byResource('claude_agent_sdk.step')
          const llmSpans = byResource('claude_agent_sdk.llm')
          const toolSpans = byResource('claude_agent_sdk.tool')

          assert.equal(querySpans.length, 1)
          assert.equal(stepSpans.length, 4)
          assert.equal(llmSpans.length, 4)
          assert.equal(toolSpans.length, 3)

          // query span: name matches resource, is trace root
          const querySpan = querySpans[0]
          assert.equal(querySpan.name, 'claude_agent_sdk.query')
          assert.equal(querySpan.parent_id.toString(), '0')

          // step spans: name is step-N
          for (const step of stepSpans) {
            assert.match(step.name, /^step-\d+$/)
          }

          // LLM spans: name is the model name, meta has model/provider tags
          for (const llm of llmSpans) {
            assert.equal(llm.name, 'claude-sonnet-4-6')
            assert.equal(llm.meta['claude-agent-sdk.request.model_name'], 'claude-sonnet-4-6')
            assert.equal(llm.meta['claude-agent-sdk.request.model_provider'], 'anthropic')
          }

          // tool spans: two weather fetches + one agent wrapper
          const weatherTools = toolSpans.filter(s => s.name === 'mcp__local__fetch_weather')
          const agentWrapper = toolSpans.find(s => s.name !== 'mcp__local__fetch_weather')
          assert.equal(weatherTools.length, 2)
          assert.ok(agentWrapper, 'agent wrapper tool span exists')

          // step parents: query or agent wrapper
          for (const step of stepSpans) {
            const parent = spanById.get(step.parent_id.toString())
            assert.ok(
              parent?.resource === 'claude_agent_sdk.query' || parent?.resource === 'claude_agent_sdk.tool',
              `step parent should be query or agent wrapper, got ${parent?.resource}`
            )
          }

          // LLM parents: step
          for (const llm of llmSpans) {
            const parent = spanById.get(llm.parent_id.toString())
            assert.equal(parent?.resource, 'claude_agent_sdk.step')
          }

          // weather tool parents: step
          for (const tool of weatherTools) {
            const parent = spanById.get(tool.parent_id.toString())
            assert.equal(parent?.resource, 'claude_agent_sdk.step')
          }
        })

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

        await tracesPromise
      })
    })
  })
})
