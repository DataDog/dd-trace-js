'use strict'

const esmEntries = [
  {
    module: {
      name: '@aws/durable-execution-sdk-js',
      versionRange: '>=1.1.0',
      filePath: 'dist/index.mjs'
    },
    functionQuery: {
      functionName: 'runHandler',
      kind: 'Async'
    },
    channelName: 'withDurableExecution'
  },
  {
    module: {
      name: '@aws/durable-execution-sdk-js',
      versionRange: '>=1.1.0',
      filePath: 'dist/index.mjs'
    },
    functionQuery: {
      methodName: 'step',
      className: 'DurableContextImpl',
      kind: 'Async'
    },
    channelName: 'DurableContextImpl_step'
  },
  {
    module: {
      name: '@aws/durable-execution-sdk-js',
      versionRange: '>=1.1.0',
      filePath: 'dist/index.mjs'
    },
    functionQuery: {
      methodName: 'invoke',
      className: 'DurableContextImpl',
      kind: 'Async'
    },
    channelName: 'DurableContextImpl_invoke'
  },
  {
    module: {
      name: '@aws/durable-execution-sdk-js',
      versionRange: '>=1.1.0',
      filePath: 'dist/index.mjs'
    },
    functionQuery: {
      methodName: 'runInChildContext',
      className: 'DurableContextImpl',
      kind: 'Async'
    },
    channelName: 'DurableContextImpl_runInChildContext'
  },
  {
    module: {
      name: '@aws/durable-execution-sdk-js',
      versionRange: '>=1.1.0',
      filePath: 'dist/index.mjs'
    },
    functionQuery: {
      methodName: 'wait',
      className: 'DurableContextImpl',
      kind: 'Async'
    },
    channelName: 'DurableContextImpl_wait'
  },
  {
    module: {
      name: '@aws/durable-execution-sdk-js',
      versionRange: '>=1.1.0',
      filePath: 'dist/index.mjs'
    },
    functionQuery: {
      methodName: 'waitForCondition',
      className: 'DurableContextImpl',
      kind: 'Async'
    },
    channelName: 'DurableContextImpl_waitForCondition'
  },
  {
    module: {
      name: '@aws/durable-execution-sdk-js',
      versionRange: '>=1.1.0',
      filePath: 'dist/index.mjs'
    },
    functionQuery: {
      methodName: 'waitForCallback',
      className: 'DurableContextImpl',
      kind: 'Async'
    },
    channelName: 'DurableContextImpl_waitForCallback'
  },
  {
    module: {
      name: '@aws/durable-execution-sdk-js',
      versionRange: '>=1.1.0',
      filePath: 'dist/index.mjs'
    },
    functionQuery: {
      methodName: 'createCallback',
      className: 'DurableContextImpl',
      kind: 'Async'
    },
    channelName: 'DurableContextImpl_createCallback'
  },
  {
    module: {
      name: '@aws/durable-execution-sdk-js',
      versionRange: '>=1.1.0',
      filePath: 'dist/index.mjs'
    },
    functionQuery: {
      methodName: 'map',
      className: 'DurableContextImpl',
      kind: 'Async'
    },
    channelName: 'DurableContextImpl_map'
  },
  {
    module: {
      name: '@aws/durable-execution-sdk-js',
      versionRange: '>=1.1.0',
      filePath: 'dist/index.mjs'
    },
    functionQuery: {
      methodName: 'parallel',
      className: 'DurableContextImpl',
      kind: 'Async'
    },
    channelName: 'DurableContextImpl_parallel'
  }
]

const cjsEntries = esmEntries.map(entry => ({
  ...entry,
  module: {
    ...entry.module,
    filePath: 'dist-cjs/index.js'
  }
}))

module.exports = [...esmEntries, ...cjsEntries]
