import assert from 'node:assert'
import { query } from '@anthropic-ai/claude-agent-sdk'

const SESSION_ID = 'test-session-id'
const MODEL = 'claude-sonnet-4-5-20250929'

const messages = [
  {
    type: 'system',
    subtype: 'init',
    cwd: '/test/path',
    session_id: SESSION_ID,
    tools: ['Task'],
    mcp_servers: [],
    model: MODEL,
    permissionMode: 'default',
    apiKeySource: 'ANTHROPIC_API_KEY',
  },
  {
    type: 'assistant',
    message: {
      id: 'msg_test_assistant_1',
      role: 'assistant',
      type: 'message',
      model: MODEL,
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    session_id: SESSION_ID,
  },
  {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    session_id: SESSION_ID,
    total_cost_usd: 0,
    usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 },
    result: 'hi',
  },
]

const abortController = new AbortController()

const q = query({
  prompt: 'Hello',
  options: {
    abortController,
    model: 'claude-sonnet-4-5',
    maxTurns: 1,
    permissionMode: 'bypassPermissions',
    cwd: process.cwd(),
  },
})

assert.ok(
  q && typeof q[Symbol.asyncIterator] === 'function',
  'query() should return an async iterable'
)

const queue = messages.slice()
q.sdkMessages = {
  next: () => Promise.resolve(
    queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined }
  ),
  return: () => Promise.resolve({ done: true, value: undefined }),
  throw: (err) => Promise.reject(err),
}

for await (const _msg of q) { // eslint-disable-line no-unused-vars
  // drive iteration to completion
}

abortController.abort()
if (typeof q.close === 'function') {
  try { q.close() } catch {}
}

// Allow dd-trace to flush the finished span to the agent before the process
// exits. With `DD_TRACE_FLUSH_INTERVAL=0` the exporter flushes per finished
// span, but the network write is still async.
await new Promise(resolve => setTimeout(resolve, 500))
