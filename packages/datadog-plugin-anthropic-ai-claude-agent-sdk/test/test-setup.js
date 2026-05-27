'use strict'

const assert = require('node:assert/strict')

class AnthropicAiClaudeAgentSdkTestSetup {
  async setup (module) {
    this.sdk = module
    this.originalQuery = this.sdk.query
  }

  async teardown () {}

  // --- Operations ---

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

    // Fail fast if the instrumented library is broken (e.g. returns undefined
    // or a non-iterable). Without this assertion a regression in the SDK or
    // our wrapper would silently pass the happy-path span test.
    assert.ok(
      q && typeof q[Symbol.asyncIterator] === 'function',
      'query() should return an async iterable'
    )

    // Abort after capturing the call-site context so the underlying Claude
    // Code subprocess does not actually spawn a real session. The first
    // iteration will reject with the abort error, which we swallow.
    abortController.abort()

    try {
      let count = 0
      // eslint-disable-next-line no-unused-vars
      for await (const _msg of q) {
        if (++count >= 1) break
      }
    } catch {
      // Expected: aborted iteration.
    } finally {
      if (typeof q.close === 'function') {
        try { q.close() } catch {}
      }
    }

    // Return a small probe of the library's observable surface so the spec
    // can assert that the wrapper preserved the public contract — the
    // `Query` object must remain an async iterable that exposes `close()`.
    return {
      isAsyncIterable: typeof q[Symbol.asyncIterator] === 'function',
      hasClose: typeof q.close === 'function',
    }
  }

  async queryError () {
    // Passing a non-AbortController for `options.abortController` causes a
    // synchronous TypeError inside tj$'s body (the SDK calls
    // `abortController.signal.addEventListener` during initialization). This
    // throw happens AFTER `tj$`'s parameter destructuring succeeds, so it
    // lands inside the orchestrion `traceSync` wrapper's try/catch — the
    // channel publishes `ctx.error` and the plugin tags the span with
    // error.{type,message,stack} and error:1.
    //
    // We cannot use the no-args `query()` form: orchestrion's traceSync
    // transform copies the original parameter list onto the OUTER wrapper, so
    // destructuring `{prompt, options}` from `undefined` throws before the
    // tracing channel's start.runStores wrapper begins.
    this.sdk.query({
      prompt: 'hello',
      options: { abortController: 'notAnAbortController' },
    })
  }
}

module.exports = AnthropicAiClaudeAgentSdkTestSetup
