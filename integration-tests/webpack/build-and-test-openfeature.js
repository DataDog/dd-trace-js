#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

// Black-box coverage for the vendored flagging provider under webpack. Unit tests on
// `server-sdk-bridge.js` fake the real `@openfeature/server-sdk` emitter in plain JS and
// never touch a bundler, so they cannot catch a regression in the generic bundler
// instrumentation mechanism (`modulesOfInterest` / `dd-trace:bundler:load`) that the
// `openfeature-server-sdk` instrumentation relies on to see the app's inlined require of
// `@openfeature/server-sdk` -- deliberately left out of `externals` below so the plugin has
// to intercept it, the same as a real customer bundle would. This builds and runs
// `openfeature-app.js`, which fails unless the bundled provider is real AND the bridged
// emitter actually fires.

const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { execFileSync } = require('child_process')
const webpack = require('webpack')
const DatadogWebpackPlugin = require('../../webpack') // dd-trace/webpack
const experiments = require('./webpack-experiments')

const OUTFILE = path.join(__dirname, 'openfeature-out.js')

function build () {
  return new Promise((resolve, reject) => {
    webpack({
      mode: 'development',
      entry: path.join(__dirname, 'openfeature-app.js'),
      target: 'node',
      externalsType: 'commonjs',
      ...(experiments && { experiments }),
      output: { filename: path.basename(OUTFILE), path: path.dirname(OUTFILE), hashFunction: 'sha256' },
      externals: [
        'diagnostics_channel',
        'pg', 'mysql2', 'better-sqlite3', 'sqlite3', 'mysql', 'oracledb', 'pg-query-stream', 'tedious',
        '@yaacovcr/transform',
        '@datadog/native-appsec', '@datadog/native-iast-taint-tracking', '@datadog/native-metrics',
        '@datadog/pprof', '@datadog/libdatadog',
      ],
      plugins: [new DatadogWebpackPlugin()],
    }, (err, stats) => {
      if (err) return reject(err)
      if (stats.hasErrors()) return reject(new Error(stats.toString({ errors: true })))
      resolve()
    })
  })
}

async function main () {
  try {
    await build()

    const runOutput = execFileSync(process.execPath, [OUTFILE], { encoding: 'utf8' })
    assert(
      runOutput.includes('PROVIDER_OK'),
      `bundled app did not load a working OpenFeature provider:\n${runOutput}`
    )

    console.log('ok')
  } finally {
    fs.rmSync(OUTFILE, { force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
