'use strict'

module.exports = [
  {
    module: {
      name: 'mcp-client',
      versionRange: '>=1.13.1',
      filePath: 'src/MCPClient.ts',
    },
    functionQuery: {
      methodName: 'callTool',
      className: 'MCPClient',
      kind: 'Async',
    },
    channelName: 'MCPClient_callTool',
  },
  {
    module: {
      name: 'mcp-client',
      versionRange: '>=1.13.1',
      filePath: 'dist/MCPClient.js',
    },
    functionQuery: {
      methodName: 'callTool',
      className: 'MCPClient',
      kind: 'Async',
    },
    channelName: 'MCPClient_callTool',
  },
  {
    module: {
      name: 'mcp-client',
      versionRange: '>=1.13.1',
      filePath: 'src/MCPClient.ts',
    },
    functionQuery: {
      methodName: 'getResource',
      className: 'MCPClient',
      kind: 'Async',
    },
    channelName: 'MCPClient_getResource',
  },
  {
    module: {
      name: 'mcp-client',
      versionRange: '>=1.13.1',
      filePath: 'dist/MCPClient.js',
    },
    functionQuery: {
      methodName: 'getResource',
      className: 'MCPClient',
      kind: 'Async',
    },
    channelName: 'MCPClient_getResource',
  },
  {
    module: {
      name: 'mcp-client',
      versionRange: '>=1.13.1',
      filePath: 'src/MCPClient.ts',
    },
    functionQuery: {
      methodName: 'getPrompt',
      className: 'MCPClient',
      kind: 'Async',
    },
    channelName: 'MCPClient_getPrompt',
  },
  {
    module: {
      name: 'mcp-client',
      versionRange: '>=1.13.1',
      filePath: 'dist/MCPClient.js',
    },
    functionQuery: {
      methodName: 'getPrompt',
      className: 'MCPClient',
      kind: 'Async',
    },
    channelName: 'MCPClient_getPrompt',
  },
  {
    module: {
      name: 'mcp-client',
      versionRange: '>=1.13.1',
      filePath: 'src/MCPClient.ts',
    },
    functionQuery: {
      methodName: 'complete',
      className: 'MCPClient',
      kind: 'Async',
    },
    channelName: 'MCPClient_complete',
  },
  {
    module: {
      name: 'mcp-client',
      versionRange: '>=1.13.1',
      filePath: 'dist/MCPClient.js',
    },
    functionQuery: {
      methodName: 'complete',
      className: 'MCPClient',
      kind: 'Async',
    },
    channelName: 'MCPClient_complete',
  },
]
