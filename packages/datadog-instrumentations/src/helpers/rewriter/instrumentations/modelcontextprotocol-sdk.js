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

// SDK 2.x bundles each class into a chunk file whose hashed name changes with every release.
const V2_CHUNK_FILE_PATH = /^dist\/[\w-]+\.[cm]js$/

function clientEntries (methodName) {
  return [
    ...['dist/esm/client/index.js', 'dist/cjs/client/index.js'].map(filePath => ({
      module: { name: '@modelcontextprotocol/sdk', versionRange: '>=1.27.1', filePath },
      functionQuery: { methodName, className: 'Client', kind: 'Async' },
      channelName: `Client_${methodName}`,
    })),
    {
      module: {
        name: '@modelcontextprotocol/client',
        versionRange: '>=2',
        filePath: V2_CHUNK_FILE_PATH,
        sourceMatch: 'var Client = class',
      },
      functionQuery: { methodName, className: 'Client', kind: 'Async' },
      channelName: `Client_${methodName}`,
    },
  ]
}

function serverEntries (methodName) {
  return [
    ...['dist/esm/server/mcp.js', 'dist/cjs/server/mcp.js'].map(filePath => ({
      module: { name: '@modelcontextprotocol/sdk', versionRange: '>=1.27.1', filePath },
      functionQuery: { methodName, className: 'McpServer', kind: 'Async' },
      channelName: `McpServer_${methodName}`,
    })),
    {
      module: {
        name: '@modelcontextprotocol/server',
        versionRange: '>=2',
        filePath: V2_CHUNK_FILE_PATH,
        sourceMatch: 'var McpServer = class',
      },
      functionQuery: { methodName, className: 'McpServer', kind: 'Async' },
      channelName: `McpServer_${methodName}`,
    },
  ]
}

module.exports = [
  ...CLIENT_METHODS.flatMap(clientEntries),
  ...SERVER_METHODS.flatMap(serverEntries),
]
