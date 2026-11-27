'use strict'

const v10Procedure = 'FunctionDeclaration[id.name="createProcedureCaller"] ' +
  'VariableDeclarator[id.name="procedure"] > FunctionExpression[id.name="resolve"]'
const v11Procedure = 'FunctionDeclaration[id.name="createProcedureCaller"] FunctionDeclaration[id.name="procedure"]'
const nodeHandler = 'FunctionDeclaration[id.name="nodeHTTPRequestHandler"]'
const normalizedNodeRequest = `${nodeHandler} BlockStatement > VariableDeclaration` +
  '[declarations.0.id.name="request"]:matches([declarations.0.init.callee.name="incomingMessageToRequest"], ' +
  '[declarations.0.init.callee.property.name="incomingMessageToRequest"])'
const legacyNodeRequest = `${nodeHandler} BlockStatement > ExpressionStatement` +
  '[expression.type="AwaitExpression"][expression.argument.arguments.0.type="ObjectExpression"]' +
  ':matches([expression.argument.callee.name="resolveHTTPResponse"], ' +
  '[expression.argument.callee.property.name="resolveHTTPResponse"])'
const legacyProcedureDispatch = 'FunctionDeclaration[id.name="inputToProcedureCall"] ' +
  'BlockStatement > VariableDeclaration' +
  '[declarations.0.init.type="AwaitExpression"][declarations.0.init.argument.arguments.0.type="ObjectExpression"]' +
  ':matches([declarations.0.init.argument.callee.name="callProcedure"], ' +
  '[declarations.0.init.argument.callee.property.name="callProcedure"])'
const legacyNodeModule = {
  name: '@trpc/server',
  versionRange: '>=10.45.2 <11',
  filePath: /^dist\/nodeHTTPRequestHandler-[A-Za-z0-9_-]+\.m?js$/,
}
const legacyResolverModule = {
  name: '@trpc/server',
  versionRange: '>=10.45.2 <11',
  filePath: /^dist\/resolveHTTPResponse-[A-Za-z0-9_-]+\.m?js$/,
}

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
    module: legacyNodeModule,
    astQuery: legacyNodeRequest,
    transform: 'publishTrpcDispatch',
    channelName: 'nodeRequest',
  },
  {
    module: legacyNodeModule,
    astQuery: nodeHandler,
    functionQuery: { kind: 'Sync' },
    channelName: 'request',
  },
  ...[
    ['>=11 <11.4', 'dist/adapters/node-http/nodeHTTPRequestHandler.js'],
    ['>=11 <11.4', 'dist/adapters/node-http/nodeHTTPRequestHandler.mjs'],
    ['>=11.4', /^dist\/node-http-[A-Za-z0-9_-]+\.cjs$/],
    ['>=11.4', /^dist\/node-http-[A-Za-z0-9_-]+\.mjs$/],
  ].flatMap(([versionRange, filePath]) => {
    const module = { name: '@trpc/server', versionRange, filePath }
    return [
      {
        module,
        astQuery: normalizedNodeRequest,
        transform: 'publishTrpcNodeRequest',
        channelName: 'nodeRequest',
      },
      {
        module,
        astQuery: nodeHandler,
        functionQuery: { kind: 'Sync' },
        channelName: 'request',
      },
    ]
  }),
  {
    module: legacyResolverModule,
    astQuery: 'FunctionDeclaration[id.name="resolveHTTPResponse"]',
    transform: 'publishTrpcRequestInfo',
    channelName: 'requestInfo',
  },
  {
    module: legacyResolverModule,
    astQuery: legacyProcedureDispatch,
    transform: 'publishTrpcDispatch',
    channelName: 'legacyProcedure',
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
