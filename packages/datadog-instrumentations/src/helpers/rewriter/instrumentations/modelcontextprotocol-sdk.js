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

// SDK 2.x client bundles each class into a chunk file whose hashed name changes with every release.
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
  return ['dist/esm/server/mcp.js', 'dist/cjs/server/mcp.js'].map(filePath => ({
    module: { name: '@modelcontextprotocol/sdk', versionRange: '>=1.27.1', filePath },
    functionQuery: { methodName, className: 'McpServer', kind: 'Async' },
    channelName: `McpServer_${methodName}`,
  }))
}

const protocolEntries = ['dist/esm/shared/protocol.js', 'dist/cjs/shared/protocol.js'].map(filePath => ({
  module: { name: '@modelcontextprotocol/sdk', versionRange: '>=1.27.1', filePath },
  functionQuery: { methodName: '_onclose', className: 'Protocol', kind: 'Sync' },
  channelName: 'Protocol__onclose',
}))

// SDK 2.x server chunk prefixes have stayed the same since 2.0: `src-` holds Protocol, and `mcp-` holds Server and
// McpServer. Their per-request state lives in modelcontextprotocol-sdk/server.js.
const V2_PROTOCOL_CHUNK = /^dist\/src-[\w-]+\.[cm]js$/
const V2_SERVER_CHUNK = /^dist\/mcp-[\w-]+\.[cm]js$/

/**
 * @param {RegExp} filePath
 * @param {string} sourceMatch
 * @param {{ methodName: string, className: string, kind: 'Sync'|'Async' }} functionQuery
 * @param {string} channelName
 */
function serverV2Entry (filePath, sourceMatch, functionQuery, channelName) {
  return {
    module: { name: '@modelcontextprotocol/server', versionRange: '>=2', filePath, sourceMatch },
    functionQuery,
    channelName,
  }
}

const serverV2Entries = [
  serverV2Entry(V2_PROTOCOL_CHUNK, 'var Protocol = class',
    { methodName: '_onrequest', className: 'Protocol', kind: 'Sync' }, 'Protocol__onrequest'),
  serverV2Entry(V2_PROTOCOL_CHUNK, 'var Protocol = class',
    { methodName: '_onclose', className: 'Protocol', kind: 'Sync' }, 'Protocol__onclose'),
  serverV2Entry(V2_SERVER_CHUNK, 'var McpServer = class',
    { methodName: '_wrapHandler', className: 'Server', kind: 'Sync' }, 'Server__wrapHandler'),
  serverV2Entry(V2_SERVER_CHUNK, 'var McpServer = class',
    { methodName: 'executeToolHandler', className: 'McpServer', kind: 'Async' }, 'McpServer_executeToolHandler'),
]

module.exports = [
  ...CLIENT_METHODS.flatMap(clientEntries),
  ...SERVER_METHODS.flatMap(serverEntries),
  ...protocolEntries,
  ...serverV2Entries,
]
