#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { promisify } = require('node:util')

const webpack = require('webpack')

const DatadogWebpackPlugin = require('../../webpack')
const testLibdatadogWasmBundle = require('../helpers/libdatadog-wasm-bundle')

const webpackAsync = promisify(webpack)

/**
 * @param {string} entry
 * @param {string} output
 * @param {boolean} [external]
 */
async function bundle (entry, output, external) {
  const stats = await webpackAsync({
    entry,
    externals: external ? ['@datadog/libdatadog-wasm'] : [],
    mode: 'development',
    module: {
      rules: [{
        include: /node_modules[\\/]@datadog[\\/]libdatadog-wasm/,
        use: [path.join(__dirname, 'transform-libdatadog-wasm-loader.js')],
      }],
    },
    output: {
      filename: path.basename(output),
      library: { type: 'commonjs2' },
      path: path.dirname(output),
    },
    plugins: [new DatadogWebpackPlugin()],
    target: 'node',
  })

  if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }))
  if (!external) {
    assert.match(fs.readFileSync(output, 'utf8'), /configured libdatadog loader ran/)
  }
}

testLibdatadogWasmBundle(bundle)
