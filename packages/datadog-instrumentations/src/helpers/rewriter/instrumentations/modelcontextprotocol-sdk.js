'use strict'

const CLIENT_METHODS = [
  'callTool',
  'listTools',
  'listResources',
  'readResource',
  'listPrompts',
  'getPrompt',
]

const SERVER_METHODS = [
  'executeToolHandler',
]

function clientEntries (methodName) {
  return ['dist/esm/client/index.js', 'dist/cjs/client/index.js'].map(filePath => ({
    module: { name: '@modelcontextprotocol/sdk', versionRange: '>=1.27.1', filePath },
    functionQuery: { methodName, className: 'Client', kind: 'Async' },
    channelName: `Client_${methodName}`,
  }))
}

function serverEntries (methodName) {
  return ['dist/esm/server/mcp.js', 'dist/cjs/server/mcp.js'].map(filePath => ({
    module: { name: '@modelcontextprotocol/sdk', versionRange: '>=1.27.1', filePath },
    functionQuery: { methodName, className: 'McpServer', kind: 'Async' },
    channelName: `McpServer_${methodName}`,
  }))
}

module.exports = [
  ...CLIENT_METHODS.flatMap(clientEntries),
  ...SERVER_METHODS.flatMap(serverEntries),
]
