#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

// Black-box coverage for the vendored flagging provider under esbuild. Unit tests on
// `server-sdk-bridge.js` fake the real `@openfeature/server-sdk` emitter in plain JS and
// never touch a bundler, so they cannot catch a regression in the generic bundler
// instrumentation mechanism (`modulesOfInterest` / `dd-trace:bundler:load`) that the
// `openfeature-server-sdk` instrumentation relies on to see the app's inlined require of
// `@openfeature/server-sdk` -- deliberately left out of `external` below so the plugin has
// to intercept it, the same as a real customer bundle would. This builds and runs
// `openfeature-app.js`, which fails unless the bundled provider is real AND the bridged
// emitter actually fires.

const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { execFileSync } = require('child_process')
const esbuild = require('esbuild')
const ddPlugin = require('../../esbuild') // dd-trace/esbuild

const OUTFILE = path.join(__dirname, 'openfeature-out.js')

async function main () {
  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'openfeature-app.js')],
      outfile: OUTFILE,
      bundle: true,
      platform: 'node',
      target: 'node18',
      plugins: [ddPlugin],
      external: [
        'pg', 'mysql2', 'better-sqlite3', 'sqlite3', 'mysql', 'mariadb', 'oracledb', 'pg-query-stream', 'tedious',
        '@yaacovcr/transform',
        '@datadog/native-appsec', '@datadog/native-iast-taint-tracking', '@datadog/native-metrics',
        '@datadog/pprof', '@datadog/libdatadog',
      ],
    })

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
