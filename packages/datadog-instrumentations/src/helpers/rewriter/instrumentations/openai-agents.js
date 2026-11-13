'use strict'

const moduleName = '@openai/agents-openai'
const versionRange = '>=0.7.0'
const functionQuery = {
  methodName: 'constructor',
  className: 'OpenAIChatCompletionsModel',
  kind: 'Sync',
}
const channelName = 'OpenAIChatCompletionsModel_constructor'

// The public MCP server classes of @openai/agents-core run their tool calls in the stores that
// subscribers bind on these start channels. The classes define callToolResult from 0.11.7. For a
// class without the method, the rewriter adds a wrapper to each instance, so older versions get
// no callToolResult entry.
const MCP_SERVER_CLASSES = ['MCPServerStdio', 'MCPServerStreamableHttp', 'MCPServerSSE']
const MCP_SERVER_METHODS = [['callTool', '>=0.7.0'], ['callToolResult', '>=0.11.7']]

/**
 * @param {string} className
 * @param {string} methodName
 * @param {string} methodVersionRange
 */
function mcpServerEntries (className, methodName, methodVersionRange) {
  return ['dist/mcp.js', 'dist/mcp.mjs'].map(filePath => ({
    module: { name: '@openai/agents-core', versionRange: methodVersionRange, filePath },
    functionQuery: { methodName, className, kind: 'Async' },
    channelName: `${className}_${methodName}`,
  }))
}

module.exports = [
  {
    module: {
      name: moduleName,
      versionRange,
      filePath: 'dist/openaiChatCompletionsModel.js',
    },
    functionQuery,
    channelName,
  },
  {
    module: {
      name: moduleName,
      versionRange,
      filePath: 'dist/openaiChatCompletionsModel.mjs',
    },
    functionQuery,
    channelName,
  },
  ...MCP_SERVER_CLASSES.flatMap(className => {
    return MCP_SERVER_METHODS.flatMap(([methodName, range]) => mcpServerEntries(className, methodName, range))
  }),
]
