#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

// End-to-end coverage for the OpenFeature optional peer chain
// `@datadog/openfeature-node-server` -> `@openfeature/server-sdk` -> `@openfeature/core`
// under webpack. Two scenarios pin the two failure modes:
//
// 1. #8635: without the dd-trace plugin, the require stays opaque so webpack never
//    follows the optional chain. A user who bundles dd-trace without opting into
//    feature flagging must not have their build fail on the missing chain.
//
// 2. #8980: with the dd-trace plugin and the peer installed, the plugin bundles the
//    peer into the output. Feature flagging then survives the bundle being relocated
//    to a tree where the peer is not on disk (e.g. a standalone deploy), instead of
//    silently falling back to the no-op provider.

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const { execFileSync } = require('child_process')
const webpack = require('webpack')
const DatadogWebpackPlugin = require('../../webpack') // dd-trace/webpack

const ENTRY = path.join(__dirname, 'openfeature-app.js')
const FLAGGING_PROVIDER = path.join('openfeature', 'flagging_provider')
const EXTERNALS = [
  'diagnostics_channel',
  'pg', 'mysql2', 'better-sqlite3', 'sqlite3', 'mysql', 'oracledb', 'pg-query-stream', 'tedious',
  '@yaacovcr/transform',
  // Optional native dd-trace modules (kept consistent with `build.js`).
  '@datadog/native-appsec', '@datadog/native-iast-taint-tracking', '@datadog/native-metrics',
  '@datadog/pprof', '@datadog/libdatadog',
  // NOTE: `@datadog/openfeature-node-server` is deliberately absent. dd-trace must keep
  // the require opaque without help from the user's webpack config.
]

/**
 * @param {string} outfile - Absolute path of the bundle to emit
 * @param {Array<object>} plugins - Webpack plugins to apply
 * @returns {Promise<object>} The webpack stats object
 */
function build (outfile, plugins) {
  return new Promise((resolve, reject) => {
    webpack({
      mode: 'development',
      entry: ENTRY,
      target: 'node',
      externalsType: 'commonjs',
      output: { filename: path.basename(outfile), path: path.dirname(outfile), hashFunction: 'sha256' },
      externals: EXTERNALS,
      plugins,
    }, (err, stats) => {
      if (err) return reject(err)
      if (stats.hasErrors()) return reject(new Error(stats.toString({ errors: true })))
      resolve(stats)
    })
  })
}

/**
 * @param {object} stats - Webpack stats object
 * @returns {Array<object>} `Critical dependency` warnings attributable to flagging_provider
 */
function flaggingProviderWarnings (stats) {
  return stats.compilation.warnings.filter((warning) =>
    /Critical dependency/.test(warning.message) &&
    (String(warning.module?.resource).includes(FLAGGING_PROVIDER) || /flagging_provider/.test(warning.message))
  )
}

async function main () {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-openfeature-'))

  try {
    // Scenario 1 (#8635): no dd-trace plugin -> the require stays opaque.
    const opaqueOut = path.join(__dirname, 'openfeature-out-opaque.js')
    const opaqueStats = await build(opaqueOut, [])
    try {
      assert.strictEqual(
        flaggingProviderWarnings(opaqueStats).length,
        0,
        'flagging_provider tripped the webpack expression-dependency path; resolve through ' +
        '`__non_webpack_require__`, not bare `require.resolve`'
      )
      const opaqueBundle = fs.readFileSync(opaqueOut).toString()
      assert(
        !opaqueBundle.includes('@datadog/flagging-core'),
        'bundle leaked `@datadog/flagging-core`; webpack must not statically follow the optional peer'
      )
      assert(
        !opaqueBundle.includes('node_modules/@openfeature/server-sdk'),
        'bundle leaked `@openfeature/server-sdk` paths; webpack must not statically follow the optional peer'
      )
    } finally {
      fs.rmSync(opaqueOut, { force: true })
    }

    // Scenario 2 (#8980): with the dd-trace plugin and the peer installed, the peer is
    // bundled, so the relocated bundle loads the real provider instead of the no-op.
    assert.strictEqual(
      isResolvable('@datadog/openfeature-node-server', __dirname),
      true,
      'the optional peer must be installed for this scenario; run `yarn install` with devDependencies'
    )
    const bundledOut = path.join(__dirname, 'openfeature-out-bundled.js')
    await build(bundledOut, [new DatadogWebpackPlugin()])
    const relocated = path.join(tmpDir, 'out.js')
    fs.copyFileSync(bundledOut, relocated)
    fs.rmSync(bundledOut, { force: true })

    assert.strictEqual(
      isResolvable('@datadog/openfeature-node-server', tmpDir),
      false,
      'the relocation dir must not resolve the peer, otherwise the test proves nothing'
    )

    const runOutput = execFileSync(process.execPath, [relocated], { encoding: 'utf8' })
    assert(
      runOutput.includes('PROVIDER_OK'),
      `relocated bundle did not load the real OpenFeature provider:\n${runOutput}`
    )

    console.log('ok')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * @param {string} request - Module specifier
 * @param {string} fromDir - Directory to resolve from
 * @returns {boolean} Whether the module resolves from `fromDir`
 */
function isResolvable (request, fromDir) {
  try {
    require.resolve(request, { paths: [fromDir] })
    return true
  } catch {
    return false
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
