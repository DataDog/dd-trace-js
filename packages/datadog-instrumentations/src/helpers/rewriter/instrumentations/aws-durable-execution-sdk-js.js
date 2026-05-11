'use strict'

const baseModule = { name: '@aws/durable-execution-sdk-js', versionRange: '>=1.1.0' }

const syncMethods = [
  ['DurableContextImpl', 'step'],
  ['DurableContextImpl', 'invoke'],
  ['DurableContextImpl', 'runInChildContext'],
  ['DurableContextImpl', 'wait'],
  ['DurableContextImpl', 'waitForCondition'],
  ['DurableContextImpl', 'waitForCallback'],
  ['DurableContextImpl', 'createCallback'],
  ['DurableContextImpl', 'map'],
  ['DurableContextImpl', 'parallel'],
]

const asyncMethods = [
  ['CheckpointManager', 'checkpoint'],
]

const buildEntries = filePath => [
  {
    module: { ...baseModule, filePath },
    functionQuery: { functionName: 'runHandler', kind: 'Async' },
    channelName: 'withDurableExecution',
  },
  ...syncMethods.map(([className, methodName]) => ({
    module: { ...baseModule, filePath },
    functionQuery: { className, methodName, kind: 'Sync' },
    channelName: `${className}_${methodName}`,
  })),
  ...asyncMethods.map(([className, methodName]) => ({
    module: { ...baseModule, filePath },
    functionQuery: { className, methodName, kind: 'Async' },
    channelName: `${className}_${methodName}`,
  })),
]

module.exports = [
  ...buildEntries('dist/index.mjs'),
  ...buildEntries('dist-cjs/index.js'),
]
