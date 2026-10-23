#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const path = require('node:path')

const webpack = require('webpack')

const DatadogWebpackPlugin = require('dd-trace/webpack')
const experiments = require('./webpack-experiments')

const format = process.argv[2]
const esm = format === 'esm'

const compiler = webpack({
  mode: 'development',
  devtool: false,
  entry: path.join(__dirname, 'builtins-app.mjs'),
  target: 'node18',
  externalsType: esm ? 'module' : 'commonjs',
  experiments: { ...experiments, ...(esm && { outputModule: true }) },
  output: {
    filename: `builtins-out.${esm ? 'mjs' : 'cjs'}`,
    path: __dirname,
    hashFunction: 'sha256',
    ...(esm && { module: true, chunkFormat: 'module', library: { type: 'module' } }),
  },
  // Older webpack versions leave the CommonJS path globals of bundled dd-trace undefined in ESM output.
  ...(esm && { node: { __dirname: true, __filename: true } }),
  externals: [
    'diagnostics_channel',
    '@datadog/native-appsec',
    '@datadog/native-iast-taint-tracking',
    '@datadog/native-metrics',
    '@datadog/pprof',
    '@datadog/libdatadog',
    '@datadog/libdatadog-extras',
    '@openfeature/server-sdk',
  ],
  plugins: [new DatadogWebpackPlugin()],
})

compiler.run((err, stats) => {
  if (err) {
    console.error(err)
    process.exit(1)
  }
  if (stats.hasErrors()) {
    console.error(stats.toString({ errors: true }))
    process.exit(1)
  }
})
