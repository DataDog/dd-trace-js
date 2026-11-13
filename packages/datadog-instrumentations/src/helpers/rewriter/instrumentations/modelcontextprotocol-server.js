'use strict'

// SDK 2.x bundles Server and McpServer into an `mcp-<hash>` chunk whose hash changes between releases.
const filePath = /^dist\/mcp-[\w-]+\.[cm]js$/

/**
 * @param {string} className
 * @param {string} methodName
 * @param {'Sync'|'Async'} kind
 */
function entry (className, methodName, kind) {
  return {
    module: { name: '@modelcontextprotocol/server', versionRange: '>=2', filePath },
    functionQuery: { methodName, className, kind },
    channelName: `${className}_${methodName}`,
  }
}

module.exports = [
  entry('Server', '_wrapHandler', 'Sync'),
  entry('McpServer', 'registerTool', 'Sync'),
  entry('McpServer', 'executeToolHandler', 'Async'),
]
