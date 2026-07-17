'use strict'

module.exports = ['dist/tools.cjs', 'dist/tools.js'].map(filePath => ({
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
}))
