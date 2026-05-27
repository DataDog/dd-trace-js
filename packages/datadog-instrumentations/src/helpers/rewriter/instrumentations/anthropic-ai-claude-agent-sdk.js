'use strict'

// The SDK's `query` export is the bundled FunctionDeclaration `tj$` (it is
// re-exported via `export { tj$ as query }`). Because it is a regular
// (non-async) function declaration that synchronously returns the query
// instance (an async iterable), we cannot use `functionQuery.functionName`:
// orchestrion's built-in selector for `functionName` requires the function
// to be `async`. We therefore target it directly via `astQuery`.
//
// KNOWN LIMITATION — `transform: 'traceSync'` (not `traceAsyncIterator`):
// The spec-ideal transform here would be `traceAsyncIterator` so the span
// covers the full async iteration lifecycle (the agent's actual work).
// However, the SDK's `Query` object replaces its `[Symbol.asyncIterator]()`
// with one that returns a fresh iterator object distinct from the wrapped
// `Query` instance — so the `_next` channel hooks that orchestrion's
// AsyncIterator wrapper installs on `Query` itself never fire during
// iteration, leaving the span open forever. With `traceSync` the span
// covers only the synchronous call to `tj$` itself.
//
// User-visible impact:
//   * Span durations report only the (near-zero) synchronous setup time of
//     `tj$`, NOT the wall-clock duration of the agent run. Customers should
//     not use this span's duration as a proxy for agent latency.
//   * Synchronous validation errors thrown inside `tj$` (e.g. invalid
//     options) ARE captured and tagged on the span.
//   * Asynchronous errors raised during iteration (rejections from
//     `query.next()`) are NOT captured by this instrumentation — they
//     surface only in the caller's `for await` loop.
module.exports = [
  {
    module: {
      name: '@anthropic-ai/claude-agent-sdk',
      versionRange: '>=0.3.152',
      filePath: 'sdk.mjs',
    },
    astQuery: 'FunctionDeclaration[id.name="tj$"]',
    transform: 'traceSync',
    channelName: 'query',
  },
]
