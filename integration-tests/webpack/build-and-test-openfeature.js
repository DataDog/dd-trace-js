#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

// Regression test for the OpenFeature optional peer load under webpack.
//
// Two failure modes are pinned here:
//
// 1. #8635: customer apps that bundle `dd-trace` must not have their build follow
//    the optional peer-of-peer chain `@datadog/openfeature-node-server` ->
//    `@openfeature/server-sdk` -> `@openfeature/core`. A literal require lets webpack
//    resolve the chain at build time and fails the build with
//    `Module not found: Can't resolve '@openfeature/core'` when the user has not
//    opted into feature flagging.
//
// 2. #8980: the require must reach dd-trace's installed provider, not whatever sits
//    next to the bundle output. Resolving through a bare `require.resolve` is rewritten
//    by webpack into an expression dependency (a `Critical dependency` warning plus a
//    directory context module) and throws at runtime, leaving evaluations on the no-op
//    provider. The resolve has to go through the `__non_webpack_require__` escape hatch.
//
// The build deliberately does not list `@datadog/openfeature-node-server` in externals —
// the whole point is that dd-trace must not require users to do so. The peer is resolvable
// at runtime from dd-trace's own location, which is what the run step exercises.

const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { execFileSync } = require('child_process')
const webpack = require('webpack')
const DatadogWebpackPlugin = require('../../webpack') // dd-trace/webpack

const OUTFILE = path.join(__dirname, 'openfeature-out.js')
const FLAGGING_PROVIDER = path.join('openfeature', 'flagging_provider')

const compiler = webpack({
  mode: 'development',
  entry: path.join(__dirname, 'openfeature-app.js'),
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

    // #8980: a bare `require.resolve(<computed>)` trips webpack's expression-dependency
    // path. Catch it at the source rather than waiting for the silent no-op at runtime.
    const flaggingWarnings = stats.compilation.warnings.filter((warning) =>
      /Critical dependency/.test(warning.message) &&
      (String(warning.module?.resource).includes(FLAGGING_PROVIDER) || /flagging_provider/.test(warning.message))
    )
    assert.strictEqual(
      flaggingWarnings.length,
      0,
      'flagging_provider tripped the webpack expression-dependency path; resolve through ' +
      '`__non_webpack_require__`, not bare `require.resolve`:\n' +
      flaggingWarnings.map((warning) => warning.message).join('\n')
    )

    const output = fs.readFileSync(OUTFILE).toString()

    // #8635: webpack must not follow the optional chain into either dependency.
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

    // #8980: run the bundle. The escape hatch must reach dd-trace's installed provider,
    // so `tracer.openfeature` is the real `FlaggingProvider` and not the no-op fallback.
    const runOutput = execFileSync(process.execPath, [OUTFILE], { encoding: 'utf8' })
    assert(
      runOutput.includes('PROVIDER_OK'),
      `bundled app did not load the real OpenFeature provider:\n${runOutput}`
    )

    console.log('ok')
  } finally {
    fs.rmSync(OUTFILE, { force: true })
  }
})
