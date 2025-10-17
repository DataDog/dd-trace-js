'use strict'

const ddPlugin = require('dd-trace/esbuild')

module.exports = {
  entryPoints: ['app.js'],
  bundle: true,
  minify: true,
  plugins: [ddPlugin],
  platform: 'node',
  target: ['node18'],
  external: [
    '@datadog/native-iast-taint-tracking',
    '@datadog/native-iast-rewriter',

    // required if you encounter graphql errors during the build step
    // see https://docs.datadoghq.com/tracing/trace_collection/automatic_instrumentation/dd_libraries/nodejs/#bundling
    'graphql/language/visitor',
    'graphql/language/printer',
    'graphql/utilities'
  ]
}
