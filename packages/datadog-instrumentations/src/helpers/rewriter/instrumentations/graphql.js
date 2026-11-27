'use strict'

const instrumentations = [
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10',
      filePath: 'execution/execute.js',
    },
    functionQuery: {
      functionName: 'execute',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:execute',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10',
      filePath: 'execution/execute.mjs',
    },
    functionQuery: {
      functionName: 'execute',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:execute',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10 <16',
      filePath: 'execution/execute.js',
    },
    functionQuery: {
      functionName: 'asErrorInstance',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:resolve:error',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10 <16',
      filePath: 'execution/execute.mjs',
    },
    functionQuery: {
      functionName: 'asErrorInstance',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:resolve:error',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10',
      filePath: 'error/locatedError.js',
    },
    functionQuery: {
      functionName: 'locatedError',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:resolve:error',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10',
      filePath: 'error/locatedError.mjs',
    },
    functionQuery: {
      functionName: 'locatedError',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:resolve:error',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10',
      filePath: 'language/parser.js',
    },
    functionQuery: {
      functionName: 'parse',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:parser',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10',
      filePath: 'language/parser.mjs',
    },
    functionQuery: {
      functionName: 'parse',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:parser',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10',
      filePath: 'validation/validate.js',
    },
    functionQuery: {
      functionName: 'validate',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:validate',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10',
      filePath: 'validation/validate.mjs',
    },
    functionQuery: {
      functionName: 'validate',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:validate',
  },
  // executeField / resolveField intentionally NOT instrumented here. Resolve spans
  // are produced by wrapping user resolvers + the default field resolver at execute
  // time (see packages/datadog-plugin-graphql/src/execute.js). That gives a zero-cost
  // fast path when no subscribers are active, which per-field orchestrion hooks
  // cannot offer (the publish is baked into graphql's compiled code).
  {
    module: {
      name: '@graphql-tools/executor',
      versionRange: '>=0.0.14',
      filePath: 'cjs/execution/execute.js',
    },
    functionQuery: {
      functionName: 'execute',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:execute',
  },
  {
    module: {
      name: '@graphql-tools/executor',
      versionRange: '>=0.0.14',
      filePath: 'esm/execution/execute.js',
    },
    functionQuery: {
      functionName: 'execute',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:execute',
  },
  {
    module: {
      name: '@graphql-tools/executor',
      versionRange: '>=0.0.14',
      filePath: 'cjs/execution/execute.js',
    },
    functionQuery: {
      functionName: 'handleFieldError',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:resolve:error',
  },
  {
    module: {
      name: '@graphql-tools/executor',
      versionRange: '>=0.0.14',
      filePath: 'esm/execution/execute.js',
    },
    functionQuery: {
      functionName: 'handleFieldError',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:resolve:error',
  },
  {
    module: {
      name: '@graphql-tools/executor',
      versionRange: '>=0.0.14',
      filePath: 'cjs/execution/normalizedExecutor.js',
    },
    functionQuery: {
      functionName: 'normalizedExecutor',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:execute',
  },
  {
    module: {
      name: '@graphql-tools/executor',
      versionRange: '>=0.0.14',
      filePath: 'esm/execution/normalizedExecutor.js',
    },
    functionQuery: {
      functionName: 'normalizedExecutor',
      kind: 'Sync',
    },
    channelName: 'apm:graphql:execute',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10',
      filePath: 'language/printer.js',
    },
    functionQuery: {
      functionName: '__module_export__',
      kind: 'Sync',
    },
    channelName: 'dd:graphql:printer:load',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10',
      filePath: 'language/visitor.js',
    },
    functionQuery: {
      functionName: '__module_export__',
      kind: 'Sync',
    },
    channelName: 'dd:graphql:visitor:load',
  },
  {
    module: {
      name: 'graphql',
      versionRange: '>=0.10',
      filePath: 'utilities/index.js',
    },
    functionQuery: {
      functionName: '__module_export__',
      kind: 'Sync',
    },
    channelName: 'dd:graphql:utilities:load',
  },
]

const graphqlExecutionFiles = ['execution/execute.js', 'execution/execute.mjs']
const fastPathInstrumentations = []
for (const instrumentation of instrumentations) {
  if (instrumentation.functionQuery?.functionName === '__module_export__') continue

  fastPathInstrumentations.push({
    ...instrumentation,
    transform: 'configureGraphqlFastPath',
  })
}

const toolsExecutionFiles = ['cjs/execution/execute.js', 'esm/execution/execute.js']
const buildExecutionContext = 'FunctionDeclaration[id.name="buildExecutionContext"]'
for (const [name, files, versionRange] of [
  ['graphql', graphqlExecutionFiles, '>=0.10'],
  ['@graphql-tools/executor', toolsExecutionFiles, '>=0.0.14'],
]) {
  for (const filePath of files) {
    instrumentations.push({
      module: { name, versionRange, filePath },
      astQuery: buildExecutionContext,
      transform: 'publishGraphqlExecutionContext',
      channelName: 'apm:graphql:execution-context',
    })
  }
}

for (const filePath of graphqlExecutionFiles) {
  instrumentations.push({
    module: { name: 'graphql', versionRange: '>=0.10 <16', filePath },
    astQuery: 'Program:has(FunctionDeclaration[id.name="executeSync"]) > FunctionDeclaration[id.name="executeImpl"]',
    transform: 'traceGraphqlExecuteSync',
    channelName: 'apm:graphql:execute',
  })
}

// GraphQL.js 17 introduced this shared executor for requests and subscription deliveries.
for (const filePath of ['execution/Executor.js', 'execution/Executor.mjs']) {
  const rootExecution = {
    module: { name: 'graphql', versionRange: '>=0.10', filePath },
    astQuery: 'ClassDeclaration[id.name="Executor"] > ClassBody > ' +
      'MethodDefinition[key.name="executeRootSelectionSet"] > FunctionExpression',
    channelName: 'apm:graphql:execute',
  }
  instrumentations.push(
    { ...rootExecution, functionQuery: { methodName: 'executeRootSelectionSet', kind: 'Sync' } },
    { ...rootExecution, transform: 'configureGraphqlRootExecution' }
  )
}

for (const filePath of toolsExecutionFiles) {
  instrumentations.push({
    module: { name: '@graphql-tools/executor', versionRange: '>=0.0.14', filePath },
    astQuery: 'CallExpression[callee.name="executeImpl"]:has(' +
      '> CallExpression[callee.name="buildPerEventExecutionContext"])',
    transform: 'traceGraphqlSubscriptionEvent',
    channelName: 'apm:graphql:execute',
  })
}

module.exports = [...instrumentations, ...fastPathInstrumentations]
