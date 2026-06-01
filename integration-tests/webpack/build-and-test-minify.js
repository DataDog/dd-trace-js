#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')
const assert = require('assert')
const webpack = require('webpack')
const DatadogWebpackPlugin = require('../../webpack') // dd-trace/webpack

const OUTFILE = path.join(__dirname, 'minify-out.js')

try {
  webpack({
    mode: 'production',
    // optimization.minimize is enabled by default in production mode
    entry: path.join(__dirname, 'basic-test.js'),
    target: 'node',
    output: {
      filename: 'minify-out.js',
      path: __dirname,
    },
    externals: ['knex'],
    plugins: [
      new DatadogWebpackPlugin(),
    ],
  })
  console.error('Expected plugin to throw an error, but it succeeded')
  process.exitCode = 1
} catch (err) {
  assert(
    err.message.includes('optimization.minimize is not compatible'),
    `should throw error about incompatible minimize, got: ${err.message}`
  )
  console.log('ok')
  process.exitCode = 0
} finally {
  fs.rmSync(OUTFILE, { force: true })
}
