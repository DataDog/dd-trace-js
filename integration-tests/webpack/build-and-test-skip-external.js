#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')
const assert = require('assert')
const webpack = require('webpack')
const DatadogWebpackPlugin = require('../../webpack') // dd-trace/webpack

const OUTFILE = path.join(__dirname, 'skip-external-out.js')

const compiler = webpack({
  mode: 'development',
  entry: path.join(__dirname, 'skip-external.js'),
  target: 'node',
  externalsType: 'commonjs',
  output: {
    filename: 'skip-external-out.js',
    path: __dirname,
    hashFunction: 'sha256',
  },
  externals: [
    // Node built-in not in webpack's default list for target: 'node'
    'diagnostics_channel',
    'knex',
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
    assert(output.includes('require("knex")'), 'bundle should contain a require call to non-bundled knex')
    assert(!output.includes('require("axios")'), 'bundle should not contain a require call to bundled axios')
    console.log('ok')
  } finally {
    fs.rmSync(OUTFILE, { force: true })
  }
})
