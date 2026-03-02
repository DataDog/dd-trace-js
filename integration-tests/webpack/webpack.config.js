'use strict'

const path = require('node:path')

const DatadogPlugin = require('../../webpack')

module.exports = {
  entry: './basic-test.js',
  output: {
    filename: 'bundle.js',
    path: path.join(__dirname, 'dist'),
  },
  target: 'node',
  mode: 'development',
  plugins: [new DatadogPlugin()],
  externals: {
    // Native addon dependencies of dd-trace that cannot be bundled
    '@datadog/native-metrics': 'commonjs @datadog/native-metrics',
    '@datadog/native-appsec': 'commonjs @datadog/native-appsec',
    '@datadog/native-iast-taint-tracking': 'commonjs @datadog/native-iast-taint-tracking',
    '@datadog/libdatadog': 'commonjs @datadog/libdatadog',
    '@datadog/pprof': 'commonjs @datadog/pprof',
    '@datadog/wasm-js-rewriter': 'commonjs @datadog/wasm-js-rewriter',
    // Optional peer dependencies not available in all projects
    '@openfeature/core': 'commonjs @openfeature/core',
    '@opentelemetry/api': 'commonjs @opentelemetry/api',
    '@opentelemetry/api-logs': 'commonjs @opentelemetry/api-logs',
  },
}
