'use strict'

/* eslint-disable no-console */

/**
 * start-dev.js — convenience script for manual end-to-end testing.
 *
 * Starts the mock-intake server and the app server in the same terminal
 * session, then prints ready-to-paste curl examples once both are listening.
 * Forwarded log records are printed to the console as they arrive.
 *
 * Usage:
 *   node integration-tests/log-capture-hooks-agent/start-dev.js [--legacy]
 *
 * Flags:
 *   --legacy     Start app-pino-legacy.js (pino < 5.14.0) instead of app.js.
 *                If the wrong pino version is installed the script installs
 *                the correct one automatically before starting (--no-save).
 *                Run `npm install` afterward to restore the version from package.json.
 *
 * Environment overrides:
 *   INTAKE_PORT  — port for the mock log-intake server (default: 7777)
 *   APP_PORT     — port for the Express app server (default: random)
 *   DD_SERVICE   — service name injected into captured logs (default: log-capture-dev)
 */

const { fork, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const { start: startIntake } = require('./mock-intake')

const legacy = process.argv.includes('--legacy')
const appFile = legacy ? 'app-pino-legacy.js' : 'app.js'

const INTAKE_PORT = parseInt(process.env.INTAKE_PORT || '7777', 10)
const APP_PORT = parseInt(process.env.APP_PORT || '0', 10)

// ── Legacy pino version check + auto-install ───────────────────────────────────
if (legacy) {
  const pinoPackageJson = path.join(__dirname, 'node_modules', 'pino', 'package.json')
  let installedVersion = null
  try {
    installedVersion = JSON.parse(fs.readFileSync(pinoPackageJson, 'utf8')).version
  } catch (_) {
    // pino not installed at all
  }

  const needsInstall = !installedVersion || (() => {
    const [major, minor] = installedVersion.split('.').map(Number)
    return major > 5 || (major === 5 && minor >= 14)
  })()

  if (needsInstall) {
    const current = installedVersion ? `v${installedVersion}` : 'not installed'
    console.log(`pino ${current} — installing pino@>=5 <5.14.0 (--no-save)...`)
    spawnSync('npm', ['install', '--no-save', 'pino@>=5 <5.14.0'], { cwd: __dirname, stdio: 'inherit' })
    console.log('Done. Run `npm install` in this directory to restore pino when finished.\n')
  } else {
    console.log(`pino v${installedVersion} already satisfies >=5 <5.14.0 — skipping install.\n`)
  }
}

// ── Start the mock-intake server in-process ────────────────────────────────────
// Each received record is pretty-printed immediately so manual curl tests give
// instant feedback without a separate terminal window.
startIntake((record) => {
  process.stdout.write('\n--- log record received ---\n')
  process.stdout.write(JSON.stringify(record, null, 2) + '\n')
  process.stdout.write('---------------------------\n')
}, INTAKE_PORT).then((intake) => {
  console.log(`Mock intake listening on http://127.0.0.1:${intake.port}`)
  if (legacy) {
    console.log('Mode: pino legacy (< 5.14.0) — wrapAsJson capture path')
  }

  // ── Start the app server ─────────────────────────────────────────────────────
  const appProc = fork(path.join(__dirname, appFile), [], {
    env: {
      ...process.env,
      APP_PORT: String(APP_PORT),
      // Tracing must be enabled for dd-trace to patch pino/winston/bunyan.
      DD_TRACE_ENABLED: 'true',
      // Point the capture sender at the local mock-intake.
      DD_LOG_CAPTURE_ENABLED: 'true',
      DD_LOG_CAPTURE_HOST: '127.0.0.1',
      DD_LOG_CAPTURE_PORT: String(intake.port),
      // Flush quickly so records appear without delay.
      DD_LOG_CAPTURE_FLUSH_INTERVAL_MS: '200',
      DD_LOGS_INJECTION: 'true',
      DD_SERVICE: process.env.DD_SERVICE || 'log-capture-dev',
      DD_ENV: process.env.DD_ENV || 'dev',
      DD_TRACE_STARTUP_LOGS: 'false',
    },
  })

  appProc.once('error', (err) => {
    console.error('app error:', err.message)
    process.exit(1)
  })

  // app.js / app-pino-legacy.js sends its port via IPC once the server is listening.
  appProc.once('message', ({ port }) => {
    const base = `http://127.0.0.1:${port}`

    console.log(`App      → ${base}  [${appFile}]`)
    console.log('\nExample curl commands:\n')

    console.log('  # pino (numeric levels: 30=info, 40=warn, 50=error)')
    console.log(`  curl ${base}/info`)
    console.log(`  curl ${base}/warn`)
    console.log(`  curl ${base}/error`)

    if (!legacy) {
      console.log('\n  # winston (string levels)')
      console.log(`  curl ${base}/winston/info`)
      console.log(`  curl ${base}/winston/warn`)
      console.log(`  curl ${base}/winston/error`)

      console.log('\n  # bunyan (numeric levels: 30=info, 40=warn, 50=error)')
      console.log(`  curl ${base}/bunyan/info`)
      console.log(`  curl ${base}/bunyan/warn`)
      console.log(`  curl ${base}/bunyan/error`)
    }

    console.log('\nForwarded log records will be printed here as they arrive.')
    console.log('Press Ctrl+C to stop.\n')
  })

  // ── Graceful shutdown ─────────────────────────────────────────────────────────
  const shutdown = () => {
    appProc.kill()
    intake.close().finally(() => process.exit(0))
  }

  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
})
