import assert from 'node:assert'
import { query } from '@anthropic-ai/claude-agent-sdk'

// Abort BEFORE iterating so the SDK does not actually spawn a Claude Code
// subprocess. The instrumentation wraps `tj$` (the bundled body of `query`)
// via orchestrion's `traceSync`, so the span is started and finished
// synchronously inside the call itself — well before any iteration would
// otherwise touch the network or fork a child process.
const abortController = new AbortController()
abortController.abort()

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

// Fail loudly if the wrapper broke the SDK's public contract — the integration
// test should not pass silently when `query()` stops returning an async
// iterable.
assert.ok(
  q && typeof q[Symbol.asyncIterator] === 'function',
  'query() should return an async iterable'
)

// Best-effort cleanup of any resources the SDK set up before we aborted.
if (typeof q.close === 'function') {
  try { q.close() } catch {}
}
