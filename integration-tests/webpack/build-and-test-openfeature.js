#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

// Regression test for https://github.com/DataDog/dd-trace-js/issues/8635.
//
// Customer apps that bundle `dd-trace` with webpack must not have their build
// follow the optional peer-of-peer chain
// `@datadog/openfeature-node-server` -> `@openfeature/server-sdk` -> `@openfeature/core`.
// Before the fix, webpack statically resolved the chain from
// `packages/dd-trace/src/openfeature/flagging_provider.js` and failed builds
// with `Module not found: Can't resolve '@openfeature/core'` when the user
// hadn't opted into feature flagging.
//
// This test deliberately does not list `@datadog/openfeature-node-server` in
// webpack's externals — the whole point is that dd-trace must not require
// users to do so.

const fs = require('fs')
const path = require('path')
const assert = require('assert')
const webpack = require('webpack')
const DatadogWebpackPlugin = require('../../webpack') // dd-trace/webpack

const OUTFILE = path.join(__dirname, 'openfeature-out.js')

const compiler = webpack({
  mode: 'development',
  entry: path.join(__dirname, 'basic-test.js'),
  target: 'node',
  externalsType: 'commonjs',
  output: {
    filename: 'openfeature-out.js',
    path: __dirname,
    hashFunction: 'sha256',
  },
  externals: [
    'diagnostics_channel',
    'pg',
    'mysql2',
    'better-sqlite3',
    'sqlite3',
    'mysql',
    'oracledb',
    'pg-query-stream',
    'tedious',
    '@yaacovcr/transform',
    // Optional native dd-trace modules (kept consistent with `build.js`).
    '@datadog/native-appsec',
    '@datadog/native-iast-taint-tracking',
    '@datadog/native-metrics',
    '@datadog/pprof',
    '@datadog/libdatadog',
    // NOTE: `@datadog/openfeature-node-server` is deliberately absent. The
    // whole point of this test is that the dd-trace source keeps the require
    // opaque to webpack without help from the user's webpack config.
  ],
  plugins: [
    new DatadogWebpackPlugin(),
  ],
})

compiler.run((err, stats) => {
  try {
    if (err) {
      console.error(err)
      process.exitCode = 1
      return
    }
    if (stats.hasErrors()) {
      console.error(stats.toString({ errors: true }))
      process.exitCode = 1
      return
    }

    const output = fs.readFileSync(OUTFILE).toString()

    // Webpack must not follow the optional chain into either dependency.
    // Both substrings only appear in the bundle when webpack resolves the
    // chain into `@datadog/openfeature-node-server`'s own source.
    assert(
      !output.includes('@datadog/flagging-core'),
      'bundle leaked `@datadog/flagging-core`; webpack must not statically ' +
      'follow `@datadog/openfeature-node-server`'
    )
    assert(
      !output.includes('node_modules/@openfeature/server-sdk'),
      'bundle leaked `@openfeature/server-sdk` paths; webpack must not ' +
      'statically follow `@datadog/openfeature-node-server`'
    )

    console.log('ok')
  } finally {
    fs.rmSync(OUTFILE, { force: true })
  }
})
