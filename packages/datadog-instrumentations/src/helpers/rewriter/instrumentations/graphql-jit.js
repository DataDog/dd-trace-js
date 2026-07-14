'use strict'

// Match the private closure only while its captured identifiers retain the verified
// 0.7–0.8 contract. A future rewrite then misses safely instead of injecting stale names.
const CREATE_BOUND_QUERY = 'FunctionDeclaration[id.name="createBoundQuery"]' +
  '[params.0.name="compilationContext"][params.1.name="document"][params.4.name="operationName"]'
const WRAP_QUERY = `${CREATE_BOUND_QUERY} ` +
  'VariableDeclarator[id.name="ret"] > ObjectExpression > Property > FunctionExpression'

/**
 * @param {string} versionRange
 * @param {string} filePath
 */
function getInstrumentations (versionRange, filePath) {
  const moduleDefinition = { name: 'graphql-jit', versionRange, filePath }
  return [
    {
      module: moduleDefinition,
      astQuery: WRAP_QUERY,
      functionQuery: { kind: 'Sync' },
      channelName: 'apm:graphql:execute',
    },
    {
      module: moduleDefinition,
      astQuery: WRAP_QUERY,
      transform: 'configureGraphqlJitExecute',
      channelName: 'apm:graphql:execute',
    },
    {
      module: moduleDefinition,
      astQuery: CREATE_BOUND_QUERY,
      functionQuery: { kind: 'Sync' },
      channelName: 'apm:graphql:compile',
    },
  ]
}

module.exports = [
  ...getInstrumentations('>=0.7.0 <0.8.5 || >=0.8.7 <0.9.0', 'dist/execution.js'),
  ...getInstrumentations('>=0.8.5 <0.8.7', 'dist/cjs/execution.js'),
  ...getInstrumentations('>=0.8.5 <0.8.7', 'dist/esm/execution.js'),
  ...getInstrumentations('>=0.8.7 <0.9.0', 'dist/execution.mjs'),
]
