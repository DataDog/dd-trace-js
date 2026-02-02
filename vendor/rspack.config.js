'use strict'

// TODO: Stop depending on `@opentelemetry/api` and instead intercept the user
//       version with an instrumentation.
// TODO: Stop depending on `@openfeature/server-sdk` and `@openfeature/core` and
//       instead intercept the user version with an instrumentation.
// TODO: Vendor `@datadog/openfeature-node-server` when the above has been
//       addressed.
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
  'source-map/lib/util' // TODO: remove usage of dependency internals
])

const exclude = new Set([
  'mutexify' // we only ever use `mutexify/promise`
])

module.exports = {
  // @ts-expect-error Array#difference exists in the Node.js version being used here.
  entry: Object.fromEntries(include.difference(exclude).entries()),
  target: 'node',
  mode: 'production',
  // Using `hidden` removes the URL comment from source files since we don't
  // publish the maps that the comments would be referencing. Since the maps
  // have the same filename as the source files this doesn't matter anyway.
  devtool: 'hidden-source-map',
  context: join(__dirname, 'node_modules'),
  optimization: {
    // Here we used `named` instead of the default of `deterministic` since the
    // default is only deterministic with the same dependencies, but when a
    // dependency is added it would change the IDs of other ones resulting in
    // unnecessary noise.
    checkIds: 'named',
    moduleIds: 'named',
  },
  // These are shared between dd-trace and users, so they need to be external.
  externals: {
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
        // The OpenTracing types are exposed in the public API of dd-trace so
        // they need to be available in the package.
        {
          from: '**/*.d.ts',
          context: join(__dirname, 'node_modules', 'opentracing', 'lib'),
          to: 'opentracing'
        },
        // Binaries need to be copied manually.
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
    path: join(__dirname, 'dist'),
    clean: true
  },
}
