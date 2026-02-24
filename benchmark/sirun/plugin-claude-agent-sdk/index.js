'use strict'

if (Number(process.env.USE_TRACER)) {
  require('../../..').init()

  // Simulate SDK module load so the plugin manager activates channel
  // subscriptions (same event that fires when the real ESM SDK is loaded).
  const { channel } = require('dc-polyfill')
  channel('dd-trace:instrumentation:load').publish({ name: '@anthropic-ai/claude-agent-sdk' })
}

const { wrapQuery } = require('../../../packages/datadog-instrumentations/src/claude-agent-sdk')

const SESSIONS = 500

// Simulate the SDK calling registered hooks, matching the real SDK's
// matcher-array contract: each event is an array of matchers, each
// matcher has an array of hook functions.
function callHooks (matchers, input, extraArg) {
  if (!matchers) return
  for (const matcher of matchers) {
    for (const hook of matcher.hooks) {
      hook(input, extraArg)
    }
  }
}

// Mock query() that simulates a realistic agent session:
// 3 turns, each with 2 tool calls = 22 hook invocations per call.
// This exercises the full shimmer path: mergeHooks, buildTracerHooks,
// runStores, and all 9 hook callbacks.
function mockQuery ({ prompt, options }) {
  const hooks = options && options.hooks ? options.hooks : {}

  callHooks(hooks.SessionStart, { session_id: 'bench', source: 'api' })

  for (let t = 0; t < 3; t++) {
    callHooks(hooks.UserPromptSubmit, { session_id: 'bench', prompt: 'p' })

    for (let u = 0; u < 2; u++) {
      const id = 'tu-' + t + '-' + u
      callHooks(hooks.PreToolUse, {
        session_id: 'bench', tool_name: 'Read',
        tool_input: { path: '/' }, tool_use_id: id
      }, id)
      callHooks(hooks.PostToolUse, {
        session_id: 'bench', tool_response: 'ok', tool_use_id: id
      }, id)
    }

    callHooks(hooks.Stop, { stop_reason: 'end_turn' })
  }

  callHooks(hooks.SessionEnd, { reason: 'done' })

  return { ok: true }
}

const wrapped = wrapQuery(mockQuery)

for (let i = 0; i < SESSIONS; i++) {
  wrapped({ prompt: 'bench', options: { model: 'claude-opus-4-6' } })
}
