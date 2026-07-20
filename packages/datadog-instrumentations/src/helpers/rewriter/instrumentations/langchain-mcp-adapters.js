'use strict'

const files = ['dist/tools.cjs', 'dist/tools.js']

module.exports = [
  ...files.map(filePath => ({
    module: {
      name: '@langchain/mcp-adapters',
      versionRange: '>=1.1.3',
      filePath,
    },
    functionQuery: {
      functionName: 'loadMcpTools',
      kind: 'Async',
    },
    channelName: 'loadMcpTools',
  })),
  ...files.map(filePath => ({
    module: {
      name: '@langchain/mcp-adapters',
      versionRange: '>=1.1.3',
      filePath,
    },
    functionQuery: {
      functionName: '_callTool',
      kind: 'Async',
    },
    channelName: '_callTool',
  })),
]
