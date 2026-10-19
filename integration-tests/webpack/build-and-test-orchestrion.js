#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const webpack = require('webpack')
const DatadogWebpackPlugin = require('../../webpack') // dd-trace/webpack
const experiments = require('./webpack-experiments')

const OUTFILE = path.join(__dirname, 'orchestrion-out.js')

const compiler = webpack({
  mode: 'development',
  entry: path.join(__dirname, 'basic-test-orchestrion.js'),
  target: 'node',
  externalsType: 'commonjs',
  ...(experiments && { experiments }),
  output: {
    filename: 'orchestrion-out.js',
    path: __dirname,
    hashFunction: 'sha256',
  },
  externals: [
    // Node built-in not in webpack's default list for target: 'node'
    'diagnostics_channel',
    // optional native dd-trace modules
    '@datadog/native-appsec',
    '@datadog/native-iast-taint-tracking',
    '@datadog/native-metrics',
    '@datadog/pprof',
    '@datadog/libdatadog',
    '@datadog/libdatadog-extras',
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

    const { status, stderr } = spawnSync('node', [OUTFILE], { encoding: 'utf8' })
    if (stderr.length) {
      console.error(stderr)
    }
    if (status) {
      throw new Error(`Generated script exited with unexpected exit code: ${status}`)
    }
    console.log('ok')
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  } finally {
    fs.rmSync(OUTFILE, { force: true })
  }
})
