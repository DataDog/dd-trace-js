'use strict'

// NOTE: Protocol.request (dist/esm|cjs/shared/protocol.js) is intentionally not instrumented here.
// It will be used for distributed tracing header injection when server-side coverage is added.

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
]
