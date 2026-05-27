'use strict'

// `query` is re-exported as the bundled FunctionDeclaration `tj$`. orchestrion's
// `functionName` selector requires `async`, so target the declaration directly
// via `astQuery`. See `async-iterator-pattern.md` for the two-channel contract.
module.exports = [
  {
    module: {
      name: '@anthropic-ai/claude-agent-sdk',
      versionRange: '>=0.3.152',
      filePath: 'sdk.mjs',
    },
    astQuery: 'FunctionDeclaration[id.name="tj$"]',
    transform: 'traceAsyncIterator',
    channelName: 'query',
  },
]
