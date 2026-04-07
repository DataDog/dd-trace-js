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
      filePath: 'dist/esm/shared/protocol.js',
    },
    functionQuery: {
      methodName: 'request',
      className: 'Protocol',
      kind: 'Async',
    },
    channelName: 'Protocol_request',
  },
  {
    module: {
      name: '@modelcontextprotocol/sdk',
      versionRange: '>=1.27.1',
      filePath: 'dist/cjs/shared/protocol.js',
    },
    functionQuery: {
      methodName: 'request',
      className: 'Protocol',
      kind: 'Async',
    },
    channelName: 'Protocol_request',
  },
]
