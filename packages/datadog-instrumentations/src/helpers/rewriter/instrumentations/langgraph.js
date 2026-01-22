'use strict'

// Note: The Pregel.stream() method uses `super.stream()` which cannot be wrapped
// by the orchestrion-style rewriter (the `super` keyword loses its lexical scope).
// We only instrument invoke() here; stream() is instrumented via shimmer in langgraph.js.
module.exports = [
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.1.1',
      filePath: 'dist/pregel/index.cjs'
    },
    functionQuery: {
      methodName: 'invoke',
      className: 'Pregel',
      kind: 'Async'
    },
    channelName: 'Pregel_invoke'
  },
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.1.1',
      filePath: 'dist/pregel/index.js'
    },
    functionQuery: {
      methodName: 'invoke',
      className: 'Pregel',
      kind: 'Async'
    },
    channelName: 'Pregel_invoke'
  }
]
