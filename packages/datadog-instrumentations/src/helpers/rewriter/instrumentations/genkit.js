'use strict'

const moduleConfig = {
  name: '@genkit-ai/core',
  versionRange: '1.21.0',
}

const functionQuery = {
  functionName: 'runInNewSpan',
  kind: 'Async',
}

module.exports = [
  {
    module: { ...moduleConfig, filePath: 'lib/tracing/instrumentation.js' },
    functionQuery,
    channelName: 'runInNewSpan',
  },
  {
    module: { ...moduleConfig, filePath: 'lib/tracing/instrumentation.mjs' },
    functionQuery,
    channelName: 'runInNewSpan',
  },
]
