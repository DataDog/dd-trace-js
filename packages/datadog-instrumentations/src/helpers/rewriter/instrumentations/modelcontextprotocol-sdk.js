'use strict'

module.exports = [
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.27.1',
      filePath: 'dist/esm/client/index.js',
    },
    functionQuery: {
      methodName: 'callTool',
      className: 'Client',
      kind: 'Async',
    },
    channelName: 'Client_callTool',
  },
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.27.1',
      filePath: 'dist/cjs/client/index.js',
    },
    functionQuery: {
      methodName: 'callTool',
      className: 'Client',
      kind: 'Async',
    },
    channelName: 'Client_callTool',
  },
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.27.1',
      filePath: 'dist/esm/client/index.js',
    },
    functionQuery: {
      methodName: 'listTools',
      className: 'Client',
      kind: 'Async',
    },
    channelName: 'Client_listTools',
  },
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.27.1',
      filePath: 'dist/cjs/client/index.js',
    },
    functionQuery: {
      methodName: 'listTools',
      className: 'Client',
      kind: 'Async',
    },
    channelName: 'Client_listTools',
  },
  // Server-side: Protocol._onrequest covers all incoming JSON-RPC requests on both
  // Server and McpServer. Trace context is extracted from extra.requestInfo.headers
  // which is populated by HTTP-based transports (SSE, StreamableHttp).
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.27.1',
      filePath: 'dist/esm/shared/protocol.js',
    },
    functionQuery: {
      methodName: '_onrequest',
      className: 'Protocol',
      kind: 'Sync',
    },
    channelName: 'Protocol__onrequest',
  },
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.27.1',
      filePath: 'dist/cjs/shared/protocol.js',
    },
    functionQuery: {
      methodName: '_onrequest',
      className: 'Protocol',
      kind: 'Sync',
    },
    channelName: 'Protocol__onrequest',
  },
  // Server-side: McpServer.executeToolHandler is a child span of the request span,
  // capturing tool name, args, and result for McpServer (high-level API) users.
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.27.1',
      filePath: 'dist/esm/server/mcp.js',
    },
    functionQuery: {
      methodName: 'executeToolHandler',
      className: 'McpServer',
      kind: 'Async',
    },
    channelName: 'McpServer_executeToolHandler',
  },
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.27.1',
      filePath: 'dist/cjs/server/mcp.js',
    },
    functionQuery: {
      methodName: 'executeToolHandler',
      className: 'McpServer',
      kind: 'Async',
    },
    channelName: 'McpServer_executeToolHandler',
  },
]
