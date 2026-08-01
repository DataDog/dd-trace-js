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

// Modules that must never become reachable from the electron entry point. Webpack rewrites
// `require('@datadog/x')` calls into `__webpack_require__(...)` for any bundled module, so a
// substring search over the emitted source (matching a literal `require("@datadog/x")`) would
// pass even when the module IS bundled - it only proves the string is absent, not that the
// module graph excludes it. Asserting against the module graph itself is the only check that
// actually discriminates a fixed entry point from a broken one.
const FORBIDDEN_MODULES = [
  'node_modules/@datadog/native-iast-taint-tracking',
  'node_modules/@datadog/wasm-js-rewriter',
]

// @datadog/native-appsec is intentionally not forbidden here: it remains reachable through
// the always-on `tracer.appsec` SDK's coupling to the WAF (appsec/sdk -> appsec/waf), which
// is a documented, out-of-scope follow-up for this change.
const EXPECTED_MODULE = 'node_modules/@datadog/native-appsec'

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

// Webpack nests modules recursively (e.g. inside ConcatenatedModule instances produced by
// scope hoisting), so the top-level `modules` list alone can miss a match buried in a
// submodule. Walk `module.modules` wherever webpack exposes it to catch those too.
function * walkModules (modules) {
  for (const module of modules ?? []) {
    yield module
    yield * walkModules(module.modules)
  }
}

function includesModule (modules, needle) {
  for (const module of walkModules(modules)) {
    const identifier = module.name ?? module.nameForCondition
    if (identifier?.includes(needle)) return true
  }
  return false
}

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

    // Ensure the output file was actually produced before asserting on the module graph.
    fs.readFileSync(OUTFILE)

    const { modules } = stats.toJson({ modules: true })

    for (const forbidden of FORBIDDEN_MODULES) {
      assert(
        !includesModule(modules, forbidden),
        `bundle should not contain a module from ${forbidden}`
      )
    }

    assert(
      includesModule(modules, EXPECTED_MODULE),
      `expected the documented exception ${EXPECTED_MODULE} to remain reachable`
    )

    console.log('ok')
  } finally {
    fs.rmSync(OUTFILE, { force: true })
  }
})
