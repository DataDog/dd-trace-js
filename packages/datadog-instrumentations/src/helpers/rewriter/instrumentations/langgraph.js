'use strict'

// NOTE: _streamIterator is intentionally NOT instrumented because it's an async generator
// function (async *_streamIterator) which cannot be wrapped by the current rewriter.
// The rewriter creates non-generator wrapper functions which causes 'yield' statements
// to fail with "Unexpected strict mode reserved word" errors.
//
// NOTE: The stream() method also CANNOT be instrumented because it uses `super.stream()`
// which breaks when the rewriter transforms the method - causing "'super' keyword unexpected here".
// Streaming functionality needs to be instrumented via a different approach (e.g., wrapping
// the returned iterable or using diagnostic channels within the library itself).

module.exports = [
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
  },
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
      filePath: 'dist/pregel/retry.js'
    },
    functionQuery: {
      functionName: '_runWithRetry',
      kind: 'Async'
    },
    channelName: '_runWithRetry'
  },
  {
    module: {
      name: '@langchain/langgraph',
      versionRange: '>=1.0.15',
      filePath: 'dist/pregel/retry.cjs'
    },
    functionQuery: {
      functionName: '_runWithRetry',
      kind: 'Async'
    },
    channelName: '_runWithRetry'
  }
]
