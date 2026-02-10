'use strict'

const path = require('path')

const Mocha = require('mocha')

const mocharc = require('../.mocharc.js')

function parseJson (value, fallback) {
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value)
    if (fallback.require && parsed.require) {
      parsed.require.push(...fallback.require)
    }
    return { ...fallback, ...parsed }
  } catch {
    return fallback
  }
}

async function main () {
  const file = process.argv[2]
  if (!file) {
    process.stderr.write('Usage: node scripts/mocha-run-file.js <test-file>\n')
    process.exitCode = 2
    return
  }

  const resolvedFile = path.resolve(file)
  // Many tests (and some production code) expect tap-like semantics where the test file is the "entrypoint".
  // Emulate that by pointing argv[1] + require.main.filename at the spec file before loading it.
  process.argv[1] = resolvedFile
  if (require.main) {
    require.main.filename = resolvedFile
  }

  if (process.env.MOCHA_RUN_FILE_DEBUG) {
    process.stderr.write(
      `mocha-run-file debug: execArgv=${JSON.stringify(process.execArgv)} gc=${typeof global.gc}\n`
    )
  }

  /**
   * @type {{
   *   timeout?: number,
   *   color?: boolean,
   *   bail?: boolean,
   *   retries?: number,
   *   fullTrace?: boolean,
   *   reporter?: string,
   *   reporterOptions?: Record<string, unknown>,
   *   require?: string[]
   * }}
   */
  const config = parseJson(process.env.MOCHA_RUN_FILE_CONFIG, mocharc)

  const mocha = new Mocha({
    ui: 'bdd',
    timeout: config.timeout ?? 5000,
    color: config.color ?? true,
    bail: config.bail ?? false,
    retries: config.retries,
    require: config.require ?? [],
    fullTrace: config.fullTrace ?? false,
    reporter: config.reporter ?? 'spec',
    reporterOptions: config.reporterOptions,
  })

  for (const req of config.require ?? []) {
    // Resolve relative to repo root (cwd), matching Mocha CLI behavior.
    const mod = require(path.resolve(req))
    if (mod?.mochaHooks) {
      mocha.rootHooks(mod.mochaHooks)
    }
  }

  mocha.addFile(resolvedFile)

  await mocha.loadFilesAsync()

  /** @type {import('mocha').Runner|undefined} */
  let runner
  const failures = await new Promise(resolve => {
    runner = mocha.run(resolve)
  })

  /** @type {{passes?: number, failures?: number, pending?: number, tests?: number, duration?: number}} */
  const stats = runner?.stats || {}

  if (typeof process.send === 'function') {
    process.send({
      type: 'mocha-run-file-result',
      file: resolvedFile,
      passes: stats.passes ?? 0,
      failures: stats.failures ?? failures ?? 0,
      pending: stats.pending ?? 0,
      tests: stats.tests ?? 0,
      duration: stats.duration ?? 0,
    })
  }

  // Ensure per-file execution behaves like tap (process-per-file): exit with the test result.
  // This also avoids hangs from leaked handles (similar to `--exit`).
  process.exit(failures ? 1 : 0)
}

main().catch(err => {
  process.stderr.write(String(err?.stack || err) + '\n')
  process.exit(1)
})
