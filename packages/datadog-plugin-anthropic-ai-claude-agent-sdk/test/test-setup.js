'use strict'

const assert = require('node:assert/strict')

const { QUERY_SUCCESS } = require('./fixtures/messages')

// Build an async iterator that yields a sequence of SDK messages then
// terminates. This mirrors dd-trace-py's `MOCK_QUERY_RESPONSE_SEQUENCE`
// pattern — see `tests/contrib/claude_agent_sdk/utils.py` — driving real
// `for await` iteration through the SDK's `Query.next` without spawning the
// `claude-code` CLI subprocess.
function messageStream (sequence) {
  const queue = sequence.slice()
  return {
    next: () => Promise.resolve(
      queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined }
    ),
    return: () => Promise.resolve({ done: true, value: undefined }),
    throw: (err) => Promise.reject(err),
  }
}

class AnthropicAiClaudeAgentSdkTestSetup {
  async setup (module) {
    this.sdk = module
  }

  async teardown () {}

  async query () {
    const abortController = new AbortController()

    const q = this.sdk.query({
      prompt: 'Say hello in one short sentence.',
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

    // Replace the SDK's subprocess-driven stream with an in-memory message
    // sequence so iteration runs deterministically without spawning the
    // `claude-code` CLI. The prototype-level `[Symbol.asyncIterator]` fix
    // applied by the instrumentation hook routes iteration through the
    // SDK's traced `Query.next`, which delegates here.
    q.sdkMessages = messageStream(QUERY_SUCCESS)

    const messages = []
    for await (const message of q) {
      messages.push(message)
    }

    abortController.abort()
    if (typeof q.close === 'function') {
      try { q.close() } catch {}
    }

    return {
      isAsyncIterable: typeof q[Symbol.asyncIterator] === 'function',
      hasClose: typeof q.close === 'function',
      messages,
    }
  }

  async queryError () {
    // Passing a non-AbortController causes `addEventListener` to throw inside
    // `tj$` synchronously, exercising the main-channel `:query:error` path.
    this.sdk.query({
      prompt: 'hello',
      options: { abortController: 'notAnAbortController' },
    })
  }
}

module.exports = AnthropicAiClaudeAgentSdkTestSetup
