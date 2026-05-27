'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

// The orchestrion rewriter wraps `tj$` (the SDK's `query`) with
// `traceAsyncIterator`, which patches `next/return/throw` on the returned
// `Query`. The SDK overrides `[Symbol.asyncIterator]()` to return its internal
// stream (`this.sdkMessages`) instead of `this`, so `for await` bypasses the
// patched methods and the `:query_next` channel never fires. Override the
// instance's `[Symbol.asyncIterator]` to return `this` so iteration goes
// through the traced methods. (Requires IITM mutability — runs via
// `--import dd-trace/initialize.mjs`. The unit test applies the same
// override directly because CJS `require()` of ESM keeps exports sealed.)
addHook({ name: '@anthropic-ai/claude-agent-sdk', versions: ['>=0.3.152'] }, exports => {
  try {
    shimmer.wrap(exports, 'query', original => function () {
      const q = original.apply(this, arguments)
      if (q && typeof q === 'object') {
        try { q[Symbol.asyncIterator] = function () { return this } } catch {}
      }
      return q
    })
  } catch {
    // ESM exports may be sealed when the module was loaded via CJS
    // `require()` (no IITM-mutable proxy). Production paths use
    // `--import dd-trace/initialize.mjs`, which goes through IITM and keeps
    // the namespace mutable. Tests that bypass IITM apply the same override
    // directly on the Query instance.
  }
  return exports
})
