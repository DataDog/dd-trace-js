'use strict'

// Mock SDK message sequences mirroring `dd-trace-py`'s
// `tests/contrib/claude_agent_sdk/utils.py`. The Claude Agent SDK communicates
// with a `claude-code` subprocess over stdin/stdout (not HTTP), so we mock at
// the message-stream layer — same approach the Python tracer uses — to drive
// real SDK iteration without spawning the bundled CLI.

const MODEL = 'claude-sonnet-4-5-20250929'
const SESSION_ID = 'test-session-id'

const SYSTEM_INIT = {
  type: 'system',
  subtype: 'init',
  cwd: '/test/path',
  session_id: SESSION_ID,
  tools: ['Task', 'Bash', 'Read', 'Write', 'Grep'],
  mcp_servers: [],
  model: MODEL,
  permissionMode: 'default',
  apiKeySource: 'ANTHROPIC_API_KEY',
}

const ASSISTANT_TEXT = {
  type: 'assistant',
  message: {
    id: 'msg_test_assistant_1',
    role: 'assistant',
    type: 'message',
    model: MODEL,
    content: [{ type: 'text', text: '4' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
  session_id: SESSION_ID,
}

const RESULT_SUCCESS = {
  type: 'result',
  subtype: 'success',
  duration_ms: 2021,
  duration_api_ms: 1925,
  is_error: false,
  num_turns: 1,
  session_id: SESSION_ID,
  total_cost_usd: 0.0484227,
  usage: {
    input_tokens: 3,
    cache_creation_input_tokens: 12742,
    cache_read_input_tokens: 1854,
    output_tokens: 5,
  },
  result: '4',
}

// A successful single-turn query: init → assistant text → result.
const QUERY_SUCCESS = [SYSTEM_INIT, ASSISTANT_TEXT, RESULT_SUCCESS]

module.exports = {
  MODEL,
  SESSION_ID,
  QUERY_SUCCESS,
}
