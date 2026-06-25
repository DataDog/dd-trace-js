'use strict'

const { spawnSync } = require('node:child_process')
const { rmSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ROOT_ENV, canonicalizePath, scriptLabel } = require('./runtime')
const finalizeSandbox = require('./finalize-sandbox')

const repoRoot = path.resolve(__dirname, '..', '..')
const mochaBin = path.join(repoRoot, 'node_modules', 'mocha', 'bin', 'mocha.js')
const nycBin = path.join(repoRoot, 'node_modules', 'nyc', 'bin', 'nyc.js')
const mergeScript = path.join(__dirname, 'merge-lcov.js')
const registerScript = path.join(__dirname, 'register.js')
const childBootstrap = path.join(__dirname, 'child-bootstrap.js')

// Plugins (named as in the PLUGINS env var) whose tests spawn real OS subprocesses and assert
// the resulting spans under tight per-test timeouts. The harness's runtime require-hook plus the
// coverage env it injects into every spawned child (which boots that require-hook in each node
// subprocess too) roughly quadruples this suite's wall time, enough to blow the per-test timeout
// on slower CI runners. So they keep the classic `nyc` flow (cached transforms, no harness)
// instead of the harness's main-process instrumentation. They have no sandbox specs, so the
// harness adds nothing for them anyway.
const CLASSIC_NYC_PLUGINS = new Set(['child_process'])

// `--instrument-main` is for suites whose tests run real product code in the mocha process
// itself (the plugin unit suites), not only in spawned sandboxes: instrument that process via
// child-bootstrap and finalize its coverage like a sandbox. Integration suites omit the flag,
// since their mocha process is only a driver, so the default leaves them unchanged.
const instrumentMain = process.argv[2] === '--instrument-main'
const mochaArgs = process.argv.slice(instrumentMain ? 3 : 2)
// `test:plugins:ci` interpolates PLUGINS into the mocha glob as `datadog-plugin-@(<PLUGINS>)`,
// so the extglob wrapper hides the bare plugin name from the path. Match PLUGINS directly.
const requestedPlugins = (process.env.PLUGINS ?? '').split('|')
const classicNyc = instrumentMain && requestedPlugins.some(plugin => CLASSIC_NYC_PLUGINS.has(plugin))
// `--expose-gc` matches the plugin unit runner. child-bootstrap loads after register so the
// collector reset and child-process patch are in place before it instruments this process.
const nodeArgs = instrumentMain && !classicNyc
  ? ['--expose-gc', mochaBin, '--require', registerScript, '--require', childBootstrap]
  : [mochaBin, '--require', registerScript]

// The tarball cache key (script label) is stable across runs, so on persistent
// environments (local dev, self-hosted runners) a stale tarball from a previous
// checkout would otherwise be silently reused. Force a fresh pack each run.
if (!process.env.DD_TEST_SANDBOX_TARBALL_PATH) {
  const label = scriptLabel() || 'default'
  process.env.DD_TEST_SANDBOX_TARBALL_PATH = path.join(os.tmpdir(), `dd-trace-coverage-sandbox-${label}.tgz`)
}
rmSync(process.env.DD_TEST_SANDBOX_TARBALL_PATH, { force: true })
rmSync(`${process.env.DD_TEST_SANDBOX_TARBALL_PATH}.lock`, { force: true })

const spawnOptions = { cwd: repoRoot, env: process.env, stdio: 'inherit' }

// Classic flow: `nyc` instruments and reports the mocha process directly (cached transforms),
// writing to the same `coverage/node-<version>` directory the upload step reads. No harness,
// no merge, no register hook.
if (classicNyc) {
  const { status } = spawnSync(nycBin, ['--', process.execPath, '--expose-gc', mochaBin, ...mochaArgs], spawnOptions)
  process.exitCode = status ?? 1
  return
}

void (async () => {
  const mochaResult = spawnSync(process.execPath, [...nodeArgs, ...mochaArgs], spawnOptions)

  if (instrumentMain) {
    // The mocha process wrote its in-process coverage to the repo-root temp dir; pull it into
    // the collector like any sandbox so merge-lcov includes it alongside the spawned children.
    process.env[ROOT_ENV] = canonicalizePath(repoRoot)
    await finalizeSandbox(repoRoot, repoRoot)
  }

  const mergeResult = spawnSync(process.execPath, [mergeScript], spawnOptions)
  process.exitCode = (mochaResult.status ?? 1) || (mergeResult.status ?? 1)
})()
