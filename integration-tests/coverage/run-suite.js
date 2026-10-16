'use strict'

const { spawn, spawnSync } = require('node:child_process')
const { once } = require('node:events')
const path = require('node:path')

const { V8_COVERAGE_ENV, getV8CoverageDir, resetCollectorRoot } = require('./runtime')

const repoRoot = path.resolve(__dirname, '..', '..')
const mochaBin = path.join(repoRoot, 'node_modules', 'mocha', 'bin', 'mocha.js')
const mergeScript = path.join(__dirname, 'merge-lcov.js')
const registerScript = path.join(__dirname, 'register.js')

// Reset the collector once, here in the parent, before V8 opens any coverage file: register.js
// must not wipe it out from under the running mocha process. Point this mocha process' own
// NODE_V8_COVERAGE at the shared collector dir so the driver process is covered too, and the
// child-process patch (installed by register.js) carries the same directory into every sandbox.
resetCollectorRoot()
const env = { ...process.env, [V8_COVERAGE_ENV]: getV8CoverageDir() }

const spawnOptions = { cwd: repoRoot, env, stdio: 'inherit' }
const mochaArgs = [mochaBin, '--require', registerScript, ...process.argv.slice(2)]

async function runMocha (version) {
  const child = spawn(process.execPath, mochaArgs, {
    ...spawnOptions,
    env: version
      ? { ...env, MOCHA_JUNIT_REPORT_SUFFIX: `vitest-${version}`, VITEST_VERSION: version }
      : env,
  })
  const [status] = await once(child, 'exit')
  return status ?? 1
}

async function main () {
  const parallelVersions = process.env.TEST_OPTIMIZATION_PARALLEL_VITEST_VERSIONS
    ?.split(',').filter(Boolean)
  const statuses = parallelVersions?.length
    ? await Promise.all(parallelVersions.map(runMocha))
    : [await runMocha()]

  // merge-lcov converts every process' profiles into one Istanbul LCOV report.
  const mergeResult = spawnSync(
    process.execPath,
    [mergeScript],
    { cwd: repoRoot, env: process.env, stdio: 'inherit' }
  )

  process.exitCode = statuses.find(status => status !== 0) || (mergeResult.status ?? 1)
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
