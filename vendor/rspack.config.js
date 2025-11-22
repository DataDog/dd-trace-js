'use strict'

const { CopyRspackPlugin } = require('@rspack/core')
const { LicenseWebpackPlugin } = require('license-webpack-plugin')
const { join } = require('path')
const pkg = require('./package.json')

const names = Object.keys(pkg.dependencies).concat([
  'mutexify/promise',
  'protobufjs/minimal',
  'retry/lib/retry_operation',
  'source-map/lib/util'
])

module.exports = {
  entry: Object.fromEntries(names.map(name => [name, name])),
  target: 'node',
  mode: 'production',
  devtool: false,
  context: join(__dirname, 'node_modules'),
  plugins: [
    new LicenseWebpackPlugin({
      outputFilename: '[name]/LICENSE',
      renderLicenses: modules => modules[0].licenseText,
      stats: {
        warnings: false
      }
    }),
    new CopyRspackPlugin({
      patterns: [
        {
          from: '**/*.d.ts',
          context: join(__dirname, 'node_modules', '@opentelemetry', 'api', 'build', 'src'),
          to: '@opentelemetry/api'
        },
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
    libraryTarget: 'commonjs2',
    path: join(__dirname, '..', 'packages', 'node_modules'),
    clean: true
  },
}
