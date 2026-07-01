import { createRequire } from 'node:module'
import path from 'node:path'
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const require = createRequire(import.meta.url)
const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk')
const anthropicDir = path.dirname(path.dirname(sdkPath))
const pathToClaudeCodeExecutable = path.join(
  anthropicDir, `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude'
)

const fetchWeather = tool(
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

const localToolsServer = createSdkMcpServer({ name: 'local', tools: [fetchWeather] })

const stream = query({
  prompt: 'Spawn a subagent to get the weather in New York. ' +
    'After that subagent, do it again but for California, not in a subagent. Both should be in fahrenheit.',
  options: {
    model: 'sonnet',
    mcpServers: { local: localToolsServer },
    allowedTools: ['mcp__local__fetch_weather'],
    disallowedTools: ['ToolSearch'],
    settingSources: [],
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
  if (!message.type) throw new Error('unexpected message')
}
