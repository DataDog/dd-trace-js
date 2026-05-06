'use strict'

const baseModule = { name: '@aws/durable-execution-sdk-js', versionRange: '>=1.1.0' }

const methods = [
  ['DurableContextImpl', 'step'],
  ['DurableContextImpl', 'invoke'],
  ['DurableContextImpl', 'runInChildContext'],
  ['DurableContextImpl', 'wait'],
  ['DurableContextImpl', 'waitForCondition'],
  ['DurableContextImpl', 'waitForCallback'],
  ['DurableContextImpl', 'createCallback'],
  ['DurableContextImpl', 'map'],
  ['DurableContextImpl', 'parallel'],
  ['CheckpointManager', 'checkpoint'],
]

const buildEntries = filePath => [
  {
    module: { ...baseModule, filePath },
    functionQuery: { functionName: 'runHandler', kind: 'Async' },
    channelName: 'withDurableExecution',
  },
  ...methods.map(([className, methodName]) => ({
    module: { ...baseModule, filePath },
    functionQuery: { className, methodName, kind: 'Async' },
    channelName: `${className}_${methodName}`,
  })),
]

module.exports = [
  ...buildEntries('dist/index.mjs'),
  ...buildEntries('dist-cjs/index.js'),
]
