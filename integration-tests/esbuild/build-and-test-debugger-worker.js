#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const esbuild = require('esbuild')
const ddPlugin = require('../../esbuild')

const MAIN_SCRIPT = './di-worker-out.js'
const WORKER_SCRIPT = './dd-trace-debugger-worker.cjs'

// Create a minimal test app that initializes dd-trace with DI enabled
const testAppCode = `
'use strict';
const tracer = require('../../').init();

// Just verify the process can start with DI enabled
console.log('DI worker test: app started successfully');

// Give it a moment to initialize, then exit cleanly
setTimeout(() => {
  process.exit(0);
}, 100);
`

// Write the test app to a temp file
const testAppPath = './di-test-app.js'
fs.writeFileSync(testAppPath, testAppCode)

esbuild.build({
  entryPoints: [testAppPath],
  bundle: true,
  outfile: MAIN_SCRIPT,
  plugins: [ddPlugin],
  platform: 'node',
  target: ['node18'],
  external: [
    // dead code paths introduced by knex if required
    'pg',
    'mysql2',
    'better-sqlite3',
    'sqlite3',
    'mysql',
    'oracledb',
    'pg-query-stream',
    'tedious',
    '@yaacovcr/transform',
  ],
}).then(() => {
  // Verify the worker bundle was emitted
  assert.ok(
    fs.existsSync(WORKER_SCRIPT),
    `Expected DI worker bundle to exist at ${WORKER_SCRIPT}`
  )

  // Verify the worker file is a valid CJS file with substantial content
  const workerContent = fs.readFileSync(WORKER_SCRIPT, 'utf8')
  assert.ok(
    workerContent.length > 1000,
    'DI worker bundle should have substantial content'
  )
  assert.ok(
    workerContent.includes('Debugger.paused') || workerContent.includes('debugger'),
    'DI worker bundle should contain debugger-related code'
  )

  // Verify the patched dd-trace lookup is present in the worker
  assert.ok(
    workerContent.includes('global._ddtrace'),
    'DI worker bundle should have patched dd-trace lookup using global._ddtrace'
  )

  // Verify the main bundle references the worker file
  const mainContent = fs.readFileSync(MAIN_SCRIPT, 'utf8')
  assert.ok(
    mainContent.includes('dd-trace-debugger-worker.cjs'),
    'Main bundle should reference the DI worker bundle'
  )

  console.log('DI worker bundle emitted correctly')

  // Run the bundled app with DI enabled to verify it starts without crashing
  // Note: The app will exit quickly since we're just testing startup
  const { status, stderr } = spawnSync('node', [MAIN_SCRIPT], {
    env: {
      ...process.env,
      DD_TRACE_DEBUG: 'true',
      DD_DYNAMIC_INSTRUMENTATION_ENABLED: 'true',
    },
    encoding: 'utf8',
    timeout: 10000,
  })

  // Log stderr for debugging if there's an issue
  if (stderr.length) {
    console.error('stderr:', stderr)
  }

  // The app should exit cleanly (status 0)
  // Note: DI may not fully initialize in this short-running test, but the process should not crash
  if (status !== 0) {
    throw new Error(`Generated script exited with unexpected exit code: ${status}`)
  }

  console.log('DI worker test: app ran successfully with DI enabled')
  console.log('ok')
}).catch((err) => {
  console.error(err)
  process.exit(1)
}).finally(() => {
  fs.rmSync(testAppPath, { force: true })
  fs.rmSync(MAIN_SCRIPT, { force: true })
  fs.rmSync(WORKER_SCRIPT, { force: true })
})
