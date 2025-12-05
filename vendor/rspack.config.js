'use strict'

// TODO: Stop depending on `@opentelemetry/api` and instead intercept the user
//       version with an instrumentation.
// TODO: Stop depending on `@openfeature/server-sdk` and `@openfeature/core` and
//       instead intercept the user version with an instrumentation.
// TODO: Fix `import-in-the-middle` so that it doesn't interfere with the global
//       object or switch to our own internal loader and remove the dependency.
// TODO: Vendor `dc-polyfill` and figure out why it fails the tests.

const { CopyRspackPlugin } = require('@rspack/core')
const { LicenseWebpackPlugin } = require('license-webpack-plugin')
const { join } = require('path')
const { dependencies } = require('./package.json')

const include = new Set([
  ...Object.keys(dependencies),
  'mutexify/promise',
  'protobufjs/minimal', // peer dependency for `@datadog/sketches-js`
  'source-map/lib/util'
])

const exclude = new Set([
  'mutexify' // we only ever use `mutexify/promise`
])

module.exports = {
  entry: Object.fromEntries(include.difference(exclude).entries()),
  target: 'node',
  mode: 'production',
  devtool: 'hidden-source-map',
  context: join(__dirname, 'node_modules'),
  optimization: {
    checkIds: 'named',
    moduleIds: 'named',
  },
  externals: {
    '@openfeature/core': '@openfeature/core',
    '@openfeature/server-sdk': '@openfeature/server-sdk',
    '@opentelemetry/api': '@opentelemetry/api'
  },
  plugins: [
    new LicenseWebpackPlugin({
      outputFilename: '[name]/LICENSE',
      excludedPackageTest: packageName => !include.has(packageName),
      renderLicenses: modules => modules[0].licenseText,
      stats: {
        warnings: false
      }
    }),
    new CopyRspackPlugin({
      patterns: [
        {
          from: '**/*.d.ts',
          context: join(__dirname, 'node_modules', 'opentracing', 'lib'),
          to: 'opentracing'
        },
        {
          from: 'source-map/lib/mappings.wasm',
          to: 'source-map'
        },
      ],
    }),
  ],
  output: {
    filename: '[name]/index.js',
    library: {
      type: 'commonjs2'
    },
    path: join(__dirname, '..', 'packages', 'node_modules'),
    clean: true
  },
}
