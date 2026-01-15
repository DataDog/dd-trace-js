'use strict'

// NOTE: The stream method is NOT instrumented via orchestrion because:
// 1. It contains a `super.stream()` call which breaks when the AST rewriter transforms
//    the method (super keyword becomes invalid outside class method context)
// 2. The _streamIterator method is an async generator (async *) which also breaks
//    when the AST rewriter transforms it (yield keyword becomes invalid)
//
// Stream instrumentation is handled via shimmer in langchain-langgraph.js instead.
module.exports = [
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.0.15',
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
      versionRange: '>=1.0.15',
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
