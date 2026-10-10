'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { promisify } = require('node:util')

const { describe, it } = require('mocha')
const semver = require('semver')

const { engines, nodeMaxMajor } = require('../../../../package.json')
const { isTrue } = require('../../../dd-trace/src/guardrails/util')

const execFileAsync = promisify(execFile)

// Outside its supported runtime range the tracer aborts instrumentation on purpose, so a child
// process has nothing to report. `DD_INJECT_FORCE` overrides that, the same way `withVersions` does.
const injectForce = process.env.DD_INJECT_FORCE
const runtimeSupported = isTrue(injectForce) ||
  semver.satisfies(process.version, `${engines.node} <${nodeMaxMajor}`)

const repositoryRoot = path.resolve(__dirname, '../../../..')
const fixture = path.join(__dirname, 'hook-module-views', 'load-order.js')

const initPath = path.join(repositoryRoot, 'init.js')
const moduleUrl = (name) => pathToFileURL(path.join(repositoryRoot, name)).href

const bootstrapModes = {
  'initialize.mjs': `--import ${moduleUrl('initialize.mjs')}`,
  'init.js + loader-hook.mjs': `--require ${initPath} --loader ${moduleUrl('loader-hook.mjs')}`,
  'register.js + init.js': `--import ${moduleUrl('register.js')} --require ${initPath}`,
}

/**
 * @typedef {object} ViewReport
 * @property {string} request
 * @property {number} publishes channel publishes the view produced for one operation
 * @property {number} [getterPublishes] getter channel publishes for the view
 * @property {boolean} matchesFirstView whether the instrumented function is the same object
 * @property {boolean} [matchesOwnDefaultExport] ESM views only
 */

/**
 * @param {string} nodeOptions
 * @param {string[]} requests view specifiers such as `cjs:url` or `esm:node:url`
 * @returns {Promise<ViewReport[]>}
 */
async function loadViews (nodeOptions, requests) {
  // A bare environment keeps an instrumented shell (`OTEL_TRACES_EXPORTER`) and a developer's
  // own `DD_*` settings out of the child, and keeps stdout to the fixture's JSON.
  const { stdout, stderr } = await execFileAsync(process.execPath, [fixture, ...requests], {
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH,
      DD_INJECT_FORCE: injectForce,
      DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
      DD_REMOTE_CONFIG_ENABLED: 'false',
      DD_TRACE_STARTUP_LOGS: 'false',
      NODE_OPTIONS: nodeOptions,
    },
  })

  assert.doesNotMatch(stderr, /Error during ddtrace instrumentation/, stderr)

  return JSON.parse(stdout)
}

;(runtimeSupported ? describe : describe.skip)('builtin instrumentation across CommonJS and ESM views', () => {
  for (const [mode, nodeOptions] of Object.entries(bootstrapModes)) {
    describe(`with ${mode}`, () => {
      it('wraps url and its getters once when CommonJS loads it before ESM', async () => {
        assert.deepStrictEqual(await loadViews(nodeOptions, ['cjs:url', 'esm:node:url']), [
          { request: 'cjs:url', publishes: 1, getterPublishes: 1, matchesFirstView: true },
          {
            request: 'esm:node:url',
            publishes: 1,
            getterPublishes: 1,
            matchesFirstView: true,
            matchesOwnDefaultExport: true,
          },
        ])
      })

      it('wraps crypto once when CommonJS loads it before ESM', async () => {
        assert.deepStrictEqual(await loadViews(nodeOptions, ['cjs:crypto', 'esm:node:crypto']), [
          { request: 'cjs:crypto', publishes: 1, matchesFirstView: true },
          { request: 'esm:node:crypto', publishes: 1, matchesFirstView: true, matchesOwnDefaultExport: true },
        ])
      })

      it('wraps vm once when ESM loads it before CommonJS', async () => {
        assert.deepStrictEqual(await loadViews(nodeOptions, ['esm:node:vm', 'cjs:vm']), [
          { request: 'esm:node:vm', publishes: 1, matchesFirstView: true, matchesOwnDefaultExport: true },
          { request: 'cjs:vm', publishes: 1, matchesFirstView: true },
        ])
      })

      it('wraps zlib once when ESM loads it before CommonJS', async () => {
        assert.deepStrictEqual(await loadViews(nodeOptions, ['esm:node:zlib', 'cjs:zlib']), [
          { request: 'esm:node:zlib', publishes: 1, matchesFirstView: true, matchesOwnDefaultExport: true },
          { request: 'cjs:zlib', publishes: 1, matchesFirstView: true },
        ])
      })

      it('wraps vm once across prefixed and unprefixed requests of every kind', async () => {
        assert.deepStrictEqual(await loadViews(nodeOptions, ['cjs:vm', 'cjs:node:vm', 'esm:vm', 'esm:node:vm']), [
          { request: 'cjs:vm', publishes: 1, matchesFirstView: true },
          { request: 'cjs:node:vm', publishes: 1, matchesFirstView: true },
          { request: 'esm:vm', publishes: 1, matchesFirstView: true, matchesOwnDefaultExport: true },
          { request: 'esm:node:vm', publishes: 1, matchesFirstView: true, matchesOwnDefaultExport: true },
        ])
      })
    })
  }
})
