#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

// Regression test for #8980 under esbuild. When the optional peer
// `@datadog/openfeature-node-server` is installed, the dd-trace esbuild plugin bundles it
// into the output so feature flagging keeps working after the bundle is relocated to a tree
// without the peer on disk (standalone deploys). Without bundling, the opaque runtime require
// resolves from the bundle directory and falls back to the no-op provider.
//
// The complementary #8635 case (peer absent -> build must not follow the optional chain) is
// covered by `openfeature.spec.js`, whose sandbox does not install the peer.

const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const { execFileSync } = require('child_process')
const esbuild = require('esbuild')
const ddPlugin = require('../../esbuild') // dd-trace/esbuild

const OUTFILE = path.join(__dirname, 'openfeature-out.js')

async function main () {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-openfeature-esbuild-'))

  try {
    assert.strictEqual(
      isResolvable('@datadog/openfeature-node-server', __dirname),
      true,
      'the optional peer must be installed for this scenario; run `yarn install` with devDependencies'
    )

    await esbuild.build({
      entryPoints: [path.join(__dirname, 'openfeature-app.js')],
      outfile: OUTFILE,
      bundle: true,
      platform: 'node',
      target: 'node18',
      plugins: [ddPlugin],
      external: [
        'pg', 'mysql2', 'better-sqlite3', 'sqlite3', 'mysql', 'oracledb', 'pg-query-stream', 'tedious',
        '@yaacovcr/transform',
        '@datadog/native-appsec', '@datadog/native-iast-taint-tracking', '@datadog/native-metrics',
        '@datadog/pprof', '@datadog/libdatadog',
      ],
    })

    const bundle = fs.readFileSync(OUTFILE).toString()
    assert(
      !bundle.includes("requireOptionalPeer('@datadog/openfeature-node-server')"),
      'the opaque peer require survived; the plugin did not inline `@datadog/openfeature-node-server`'
    )

    const relocated = path.join(tmpDir, 'out.js')
    fs.copyFileSync(OUTFILE, relocated)
    assert.strictEqual(
      isResolvable('@datadog/openfeature-node-server', tmpDir),
      false,
      'the relocation dir must not resolve the peer, otherwise the test proves nothing'
    )

    // The native span pipeline requires `@datadog/libdatadog`, a native module
    // that ships platform .wasm/.node binaries and is therefore externalized
    // (it can't be bundled). In a real standalone deploy the external native
    // deps travel with the bundle, so make it resolvable from the relocation
    // dir. The point of this test is that the *bundled* OpenFeature peer
    // survives — not the externalized native deps — and the peer is left
    // unresolvable above.
    const relocatedDatadog = path.join(tmpDir, 'node_modules', '@datadog')
    fs.mkdirSync(relocatedDatadog, { recursive: true })
    fs.symlinkSync(
      path.dirname(require.resolve('@datadog/libdatadog')),
      path.join(relocatedDatadog, 'libdatadog'),
      'junction'
    )

    const runOutput = execFileSync(process.execPath, [relocated], { encoding: 'utf8' })
    assert(
      runOutput.includes('PROVIDER_OK'),
      `relocated bundle did not load the real OpenFeature provider:\n${runOutput}`
    )

    console.log('ok')
  } finally {
    fs.rmSync(OUTFILE, { force: true })
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
