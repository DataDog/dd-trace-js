#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const path = require('path')
const webpack = require('webpack')
const DatadogWebpackPlugin = require('../../webpack') // dd-trace/webpack

const compiler = webpack({
  mode: 'development',
  entry: path.join(__dirname, 'basic-test.js'),
  target: 'node',
  externalsType: 'commonjs',
  output: {
    filename: 'out.js',
    path: __dirname,
    hashFunction: 'sha256',
  },
  externals: [
    // Node built-in not in webpack's default list for target: 'node'
    'diagnostics_channel',
    // dead code paths introduced by knex
    'pg',
    'mysql2',
    'better-sqlite3',
    'sqlite3',
    'mysql',
    'oracledb',
    'pg-query-stream',
    'tedious',
    '@yaacovcr/transform',
    // optional native dd-trace modules
    '@datadog/native-appsec',
    '@datadog/native-iast-taint-tracking',
    '@datadog/native-metrics',
    '@datadog/pprof',
    '@datadog/libdatadog',
  ],
  plugins: [
    new DatadogWebpackPlugin(),
  ],
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
