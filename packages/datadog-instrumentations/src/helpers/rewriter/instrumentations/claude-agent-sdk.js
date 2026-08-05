'use strict'

module.exports = [
  {
    module: {
      name: '@anthropic-ai/claude-agent-sdk',
      versionRange: '>=0.2.113',
      filePath: 'sdk.mjs',
    },
    functionQuery: {
      functionName: 'query',
      kind: 'Async',
      isExportAlias: true,
    },
    channelName: 'query',
  },
]
