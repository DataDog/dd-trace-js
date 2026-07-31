#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')
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
    console.log('ok')
  } finally {
    fs.rmSync(OUTFILE, { force: true })
  }
})
