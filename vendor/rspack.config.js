'use strict'

const { CopyRspackPlugin } = require('@rspack/core')
const { LicenseWebpackPlugin } = require('license-webpack-plugin')
const { join } = require('path')
const { dependencies } = require('./package.json')
const { dependencies: iitmDeps } = require('./node_modules/import-in-the-middle/package.json')

const include = new Set([
  ...Object.keys(dependencies),
  ...Object.keys(iitmDeps),
  'graphql/language',
  'mutexify/promise',
  'protobufjs/minimal', // peer dependency for `@datadog/sketches-js`
  'source-map/lib/util'
])

const exclude = new Set([
  'graphql', // we only use some internals to interact with the AST
  'import-in-the-middle', // too complex to transpile so we copy it instead
  'mutexify' // we only ever use `mutexify/promise`
])

module.exports = {
  entry: Object.fromEntries(include.difference(exclude).entries()),
  target: 'node',
  mode: 'production',
  devtool: false,
  context: join(__dirname, 'node_modules'),
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
          from: 'import-in-the-middle/*.js',
          info: { minimized: true }
        },
        {
          from: 'import-in-the-middle/*.mjs',
          info: { minimized: true }
        },
        {
          from: 'import-in-the-middle/LICENSE',
          to: 'import-in-the-middle',
          info: { minimized: true }
        },
        {
          from: 'import-in-the-middle/lib',
          to: 'import-in-the-middle/lib',
          info: { minimized: true }
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
