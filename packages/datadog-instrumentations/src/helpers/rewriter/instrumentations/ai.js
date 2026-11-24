'use strict'

// v4–6 publish separate CommonJS (.js) and ESM (.mjs) builds. v7 is ESM-only and uses
// dist/index.js for both import and require, so that file must still be rewritten for setup to run.
module.exports = [
  // getTracer - for patching tracer
  {
    module: {
      name: 'ai',
      versionRange: '>=4.0.0 <7.0.0',
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
      versionRange: '>=4.0.0 <7.0.0',
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
      versionRange: '>=6.0.0 <7.0.0',
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
      versionRange: '>=6.0.0 <7.0.0',
      filePath: 'dist/index.mjs',
    },
    functionQuery: {
      functionName: 'selectTelemetryAttributes',
      kind: 'Async',
    },
    channelName: 'selectTelemetryAttributes',
  },
  // resolveLanguageModel called by all LLM entry points, its result is the resolved model instance.
  {
    module: {
      name: 'ai',
      versionRange: '>=6.0.0',
      filePath: 'dist/index.js',
    },
    functionQuery: {
      functionName: 'resolveLanguageModel',
      kind: 'Sync',
    },
    channelName: 'resolveLanguageModel',
  },
  // AI SDK v7 filters runtime context from tracing channel events unless each key is included.
  {
    module: {
      name: 'ai',
      versionRange: '>=7.0.0',
      filePath: 'dist/index.js',
    },
    functionQuery: {
      functionName: 'generateText',
      kind: 'Async',
    },
    channelName: 'includeRuntimeContext',
  },
  {
    module: {
      name: 'ai',
      versionRange: '>=7.0.0',
      filePath: 'dist/index.js',
    },
    functionQuery: {
      functionName: 'streamText',
      kind: 'Sync',
    },
    channelName: 'includeRuntimeContext',
  },
  {
    module: {
      name: 'ai',
      versionRange: '>=6.0.0',
      filePath: 'dist/index.mjs',
    },
    functionQuery: {
      functionName: 'resolveLanguageModel',
      kind: 'Sync',
    },
    channelName: 'resolveLanguageModel',
  },
]
