'use strict'

const v10Procedure = 'FunctionDeclaration[id.name="createProcedureCaller"] ' +
  'VariableDeclarator[id.name="procedure"] > FunctionExpression[id.name="resolve"]'
const v11Procedure = 'FunctionDeclaration[id.name="createProcedureCaller"] FunctionDeclaration[id.name="procedure"]'

module.exports = [
  {
    module: { name: '@trpc/server', versionRange: '>=10.45.2 <11', filePath: 'dist/index.js' },
    astQuery: v10Procedure,
    functionQuery: { kind: 'Async' },
    channelName: 'procedure',
  },
  {
    module: { name: '@trpc/server', versionRange: '>=10.45.2 <11', filePath: 'dist/index.mjs' },
    astQuery: v10Procedure,
    functionQuery: { kind: 'Async' },
    channelName: 'procedure',
  },
  {
    module: {
      name: '@trpc/server',
      versionRange: '>=11 <11.4',
      filePath: 'dist/unstable-core-do-not-import/procedureBuilder.js',
    },
    astQuery: v11Procedure,
    functionQuery: { kind: 'Async' },
    channelName: 'procedure',
  },
  {
    module: {
      name: '@trpc/server',
      versionRange: '>=11 <11.4',
      filePath: 'dist/unstable-core-do-not-import/procedureBuilder.mjs',
    },
    astQuery: v11Procedure,
    functionQuery: { kind: 'Async' },
    channelName: 'procedure',
  },
  {
    module: {
      name: '@trpc/server',
      versionRange: '>=11.4',
      filePath: /^dist\/initTRPC-[A-Za-z0-9_-]+\.cjs$/,
    },
    astQuery: v11Procedure,
    functionQuery: { kind: 'Async' },
    channelName: 'procedure',
  },
  {
    module: {
      name: '@trpc/server',
      versionRange: '>=11.4',
      filePath: /^dist\/initTRPC-[A-Za-z0-9_-]+\.mjs$/,
    },
    astQuery: v11Procedure,
    functionQuery: { kind: 'Async' },
    channelName: 'procedure',
  },
  {
    module: { name: '@trpc/server', versionRange: '>=10.45.2 <11', filePath: /^dist\/nodeHTTPRequestHandler-[A-Za-z0-9_-]+\.js$/ },
    astQuery: 'FunctionDeclaration[id.name="nodeHTTPRequestHandler"]',
    functionQuery: { kind: 'Sync' },
    channelName: 'request',
  },
  {
    module: { name: '@trpc/server', versionRange: '>=10.45.2 <11', filePath: /^dist\/nodeHTTPRequestHandler-[A-Za-z0-9_-]+\.mjs$/ },
    astQuery: 'FunctionDeclaration[id.name="nodeHTTPRequestHandler"]',
    functionQuery: { kind: 'Sync' },
    channelName: 'request',
  },
  {
    module: {
      name: '@trpc/server',
      versionRange: '>=11 <11.4',
      filePath: 'dist/adapters/node-http/nodeHTTPRequestHandler.js',
    },
    astQuery: 'FunctionDeclaration[id.name="nodeHTTPRequestHandler"]',
    functionQuery: { kind: 'Sync' },
    channelName: 'request',
  },
  {
    module: {
      name: '@trpc/server',
      versionRange: '>=11 <11.4',
      filePath: 'dist/adapters/node-http/nodeHTTPRequestHandler.mjs',
    },
    astQuery: 'FunctionDeclaration[id.name="nodeHTTPRequestHandler"]',
    functionQuery: { kind: 'Sync' },
    channelName: 'request',
  },
  {
    module: { name: '@trpc/server', versionRange: '>=11.4', filePath: /^dist\/node-http-[A-Za-z0-9_-]+\.cjs$/ },
    astQuery: 'FunctionDeclaration[id.name="nodeHTTPRequestHandler"]',
    functionQuery: { kind: 'Sync' },
    channelName: 'request',
  },
  {
    module: { name: '@trpc/server', versionRange: '>=11.4', filePath: /^dist\/node-http-[A-Za-z0-9_-]+\.mjs$/ },
    astQuery: 'FunctionDeclaration[id.name="nodeHTTPRequestHandler"]',
    functionQuery: { kind: 'Sync' },
    channelName: 'request',
  },
  {
    module: { name: '@trpc/server', versionRange: '>=10.45.2 <11', filePath: /^dist\/resolveHTTPResponse-[A-Za-z0-9_-]+\.js$/ },
    astQuery: 'FunctionDeclaration[id.name="resolveHTTPResponse"]',
    transform: 'publishTrpcRequestInfo',
    channelName: 'requestInfo',
  },
  {
    module: { name: '@trpc/server', versionRange: '>=10.45.2 <11', filePath: /^dist\/resolveHTTPResponse-[A-Za-z0-9_-]+\.mjs$/ },
    astQuery: 'FunctionDeclaration[id.name="resolveHTTPResponse"]',
    transform: 'publishTrpcRequestInfo',
    channelName: 'requestInfo',
  },
  {
    module: {
      name: '@trpc/server',
      versionRange: '>=11 <11.4',
      filePath: 'dist/unstable-core-do-not-import/http/contentType.js',
    },
    astQuery: 'FunctionDeclaration[id.name="getRequestInfo"]',
    functionQuery: { kind: 'Async' },
    channelName: 'requestInfo',
  },
  {
    module: {
      name: '@trpc/server',
      versionRange: '>=11 <11.4',
      filePath: 'dist/unstable-core-do-not-import/http/contentType.mjs',
    },
    astQuery: 'FunctionDeclaration[id.name="getRequestInfo"]',
    functionQuery: { kind: 'Async' },
    channelName: 'requestInfo',
  },
  {
    module: { name: '@trpc/server', versionRange: '>=11.4', filePath: /^dist\/resolveResponse-[A-Za-z0-9_-]+\.cjs$/ },
    astQuery: 'FunctionDeclaration[id.name="getRequestInfo"]',
    functionQuery: { kind: 'Async' },
    channelName: 'requestInfo',
  },
  {
    module: { name: '@trpc/server', versionRange: '>=11.4', filePath: /^dist\/resolveResponse-[A-Za-z0-9_-]+\.mjs$/ },
    astQuery: 'FunctionDeclaration[id.name="getRequestInfo"]',
    functionQuery: { kind: 'Async' },
    channelName: 'requestInfo',
  },
]
