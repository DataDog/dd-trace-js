'use strict'

const ddPlugin = require('dd-trace/esbuild')

module.exports = {
  entryPoints: ['app.js'],
  bundle: true,
  minify: true,
  keepNames: true,
  plugins: [ddPlugin],
  platform: 'node',
  target: ['node18'],
  external: [
    '@datadog/native-iast-taint-tracking',
    '@datadog/wasm-js-rewriter',
    '@openfeature/server-sdk'
  ]
}
