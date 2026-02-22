'use strict'

module.exports = [
  // getTracer - for patching tracer
  {
    module: {
      name: 'ai',
      versionRange: '>=4.0.0',
      filePath: 'dist/index.js',
    },
    functionQuery: {
      functionName: 'getTracer',
      kind: 'Sync',
    },
    channelName: 'getTracer',
  },
  {
    module: {
      name: 'ai',
      versionRange: '>=4.0.0',
      filePath: 'dist/index.mjs',
    },
    functionQuery: {
      functionName: 'getTracer',
      kind: 'Sync',
    },
    channelName: 'getTracer',
  },
  // selectTelemetryAttributes - makes sure we set isEnabled properly
  {
    module: {
      name: 'ai',
      versionRange: '>=4.0.0 <6.0.0',
      filePath: 'dist/index.js',
    },
    functionQuery: {
      functionName: 'selectTelemetryAttributes',
      kind: 'Sync',
    },
    channelName: 'selectTelemetryAttributes',
  },
  {
    module: {
      name: 'ai',
      versionRange: '>=4.0.0 <6.0.0',
      filePath: 'dist/index.mjs',
    },
    functionQuery: {
      functionName: 'selectTelemetryAttributes',
      kind: 'Sync',
    },
    channelName: 'selectTelemetryAttributes',
  },
  {
    module: {
      name: 'ai',
      versionRange: '>=6.0.0',
      filePath: 'dist/index.js',
    },
    functionQuery: {
      functionName: 'selectTelemetryAttributes',
      kind: 'Async',
    },
    channelName: 'selectTelemetryAttributes',
  },
  {
    module: {
      name: 'ai',
      versionRange: '>=6.0.0',
      filePath: 'dist/index.mjs',
    },
    functionQuery: {
      functionName: 'selectTelemetryAttributes',
      kind: 'Async',
    },
    channelName: 'selectTelemetryAttributes',
  },
  // tool
  {
    module: {
      name: 'ai',
      versionRange: '>=4.0.0',
      filePath: 'dist/index.js',
    },
    functionQuery: {
      functionName: 'tool',
      kind: 'Sync',
    },
    channelName: 'tool',
  },
  {
    module: {
      name: 'ai',
      versionRange: '>=4.0.0',
      filePath: 'dist/index.mjs',
    },
    functionQuery: {
      functionName: 'tool',
      kind: 'Sync',
    },
    channelName: 'tool',
  },
]
