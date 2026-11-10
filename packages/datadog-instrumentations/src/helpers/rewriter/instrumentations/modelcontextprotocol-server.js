'use strict'

// SDK 2.x bundles its classes into chunk files whose hashed names change with every release. The chunk prefixes have
// stayed the same since 2.0: `src-` holds Protocol, and `mcp-` holds Server and McpServer.
const PROTOCOL_CHUNK = /^dist\/src-[\w-]+\.[cm]js$/
const SERVER_CHUNK = /^dist\/mcp-[\w-]+\.[cm]js$/

/**
 * @param {RegExp} filePath
 * @param {string} sourceMatch
 */
function serverModule (filePath, sourceMatch) {
  return { name: '@modelcontextprotocol/server', versionRange: '>=2', filePath, sourceMatch }
}

module.exports = [
  {
    module: serverModule(PROTOCOL_CHUNK, 'var Protocol = class'),
    functionQuery: { methodName: '_onrequest', className: 'Protocol', kind: 'Sync' },
    channelName: 'Protocol__onrequest',
  },
  {
    module: serverModule(PROTOCOL_CHUNK, 'var Protocol = class'),
    functionQuery: { methodName: '_onclose', className: 'Protocol', kind: 'Sync' },
    channelName: 'Protocol__onclose',
  },
  {
    module: serverModule(SERVER_CHUNK, 'var McpServer = class'),
    functionQuery: { methodName: '_wrapHandler', className: 'Server', kind: 'Sync' },
    channelName: 'Server__wrapHandler',
  },
  {
    module: serverModule(SERVER_CHUNK, 'var McpServer = class'),
    functionQuery: { methodName: 'executeToolHandler', className: 'McpServer', kind: 'Async' },
    channelName: 'McpServer_executeToolHandler',
  },
]
