#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')
const assert = require('assert')
const webpack = require('webpack')
const DatadogWebpackPlugin = require('../../webpack') // dd-trace/webpack
const experiments = require('./webpack-experiments')

const OUTFILE = path.join(__dirname, 'electron-out.js')

const compiler = webpack({
  mode: 'development',
  entry: path.join(__dirname, '..', '..', 'packages', 'dd-trace', 'index.electron.js'),
  target: 'node',
  externalsType: 'commonjs',
  ...(experiments && { experiments }),
  output: {
    filename: 'electron-out.js',
    path: __dirname,
    hashFunction: 'sha256',
  },
  externals: [
    // Node built-in not in webpack's default list for target: 'node'
    'diagnostics_channel',
    // out of scope for this change: still hardcoded requires reachable from index.electron.js
    '@datadog/native-metrics',
    '@datadog/pprof',
    '@datadog/libdatadog',
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

    // Package names also appear as inert text inside the bundled package.json metadata
    // (e.g. optionalDependencies, read by startup-log.js/span_stats.js), so assert on an actual
    // require() call rather than a bare substring match, matching build-and-test-skip-external.js.
    //
    // @datadog/native-appsec is intentionally not asserted here: it remains reachable through
    // the always-on `tracer.appsec` SDK's coupling to the WAF (appsec/sdk -> appsec/waf), which
    // is a documented, out-of-scope follow-up for this change.
    assert(
      !output.includes('require("@datadog/native-iast-taint-tracking")'),
      'bundle should not contain a require call to @datadog/native-iast-taint-tracking'
    )
    assert(
      !output.includes('require("@datadog/wasm-js-rewriter")'),
      'bundle should not contain a require call to @datadog/wasm-js-rewriter'
    )

    console.log('ok')
  } finally {
    fs.rmSync(OUTFILE, { force: true })
  }
})
