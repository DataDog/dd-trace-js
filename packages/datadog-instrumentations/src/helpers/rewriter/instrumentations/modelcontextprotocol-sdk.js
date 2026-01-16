'use strict'

// Note: Methods that use 'super' keyword cannot be instrumented with Orchestrion AST rewriting.
// Client.connect and Client.close call super.connect()/super.close() from Protocol base class.
// McpServer.connect and McpServer.close also use super calls.
// We only instrument methods that do NOT use super.

module.exports = [
  // Client methods that don't use super
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.25.2',
      filePath: 'dist/cjs/client/index.js'
    },
    functionQuery: {
      methodName: 'callTool',
      className: 'Client',
      kind: 'Async'
    },
    channelName: 'Client_callTool'
  },
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.25.2',
      filePath: 'dist/esm/client/index.js'
    },
    functionQuery: {
      methodName: 'callTool',
      className: 'Client',
      kind: 'Async'
    },
    channelName: 'Client_callTool'
  },
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.25.2',
      filePath: 'dist/cjs/client/index.js'
    },
    functionQuery: {
      methodName: 'listTools',
      className: 'Client',
      kind: 'Async'
    },
    channelName: 'Client_listTools'
  },
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.25.2',
      filePath: 'dist/esm/client/index.js'
    },
    functionQuery: {
      methodName: 'listTools',
      className: 'Client',
      kind: 'Async'
    },
    channelName: 'Client_listTools'
  },
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.25.2',
      filePath: 'dist/cjs/client/index.js'
    },
    functionQuery: {
      methodName: 'listResources',
      className: 'Client',
      kind: 'Async'
    },
    channelName: 'Client_listResources'
  },
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.25.2',
      filePath: 'dist/esm/client/index.js'
    },
    functionQuery: {
      methodName: 'listResources',
      className: 'Client',
      kind: 'Async'
    },
    channelName: 'Client_listResources'
  },
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.25.2',
      filePath: 'dist/cjs/client/index.js'
    },
    functionQuery: {
      methodName: 'readResource',
      className: 'Client',
      kind: 'Async'
    },
    channelName: 'Client_readResource'
  },
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.25.2',
      filePath: 'dist/esm/client/index.js'
    },
    functionQuery: {
      methodName: 'readResource',
      className: 'Client',
      kind: 'Async'
    },
    channelName: 'Client_readResource'
  }
]
