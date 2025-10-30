'use strict'

const codeTransformer = require('@apm-js-collab/code-transformer')

// The full instrumentation config
const instrumentation = {
  // The name of the diagnostics channel
  channelName: 'my-channel',
  // Define the module you'd like to inject tracing channels into
  module: {
    name: 'my-module',
    versionRange: '>=1.0.0',
    filePath: './dist/index.js',
  },
  // Define the function you'd like to instrument
  // (e.g., match a method named 'foo' that returns a Promise)
  functionQuery: {
    methodName: 'fetch',
    kind: 'Async',
  },
}

// Create an InstrumentationMatcher with an array of instrumentation configs
const matcher = codeTransformer.create([instrumentation])

// Get a transformer for a specific module
const transformer = matcher.getTransformer(
  'my-module',
  '1.2.3',
  './dist/index.js',
)

if (transformer === undefined) {
  throw new Error('No transformer found for module')
}

// Transform code
const inputCode = 'async function fetch() { return 42; }'

try {
  const result = transformer.transform(inputCode, 'unknown')
  console.log(result.code)
} catch (e) {
  console.log(e)
}

// Both the matcher and transformer should be freed after use!
matcher.free()
transformer.free()
