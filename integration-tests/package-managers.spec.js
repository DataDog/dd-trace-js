'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { promisify } = require('node:util')

const semver = require('semver')

const { sandboxCwd, useSandbox } = require('./helpers')

const execFileAsync = promisify(execFile)

// The last pnpm release that fails every command while an asynchronous loader hook is registered.
const PNPM_VERSION = '11.20.0'

describe('package managers', () => {
  let cwd, pnpmEngines

  useSandbox([`pnpm@${PNPM_VERSION}`], false, ['./integration-tests/package-managers'])

  before(() => {
    cwd = sandboxCwd()
    pnpmEngines = JSON.parse(readFileSync(path.join(cwd, 'node_modules/pnpm/package.json'), 'utf8')).engines.node
  })

  /**
   * @param {string} entryPoint
   * @param {string[]} args
   */
  async function run (entryPoint, args) {
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd,
      env: { ...process.env, NODE_OPTIONS: `--import ${entryPoint}`, DD_TRACE_STARTUP_LOGS: 'false' },
    })
    return stdout
  }

  for (const entryPoint of ['dd-trace/register.js', 'dd-trace/initialize.mjs']) {
    describe(`with --import ${entryPoint}`, () => {
      for (const packageManager of ['pnpm', 'pnpx', 'corepack']) {
        it(`does not register the loader hooks in bin/${packageManager}`, async () => {
          const stdout = await run(entryPoint, [`package-managers/bin/${packageManager}.mjs`])

          assert.deepStrictEqual(JSON.parse(stdout), { code: 'ERR_MODULE_NOT_FOUND', isNativeError: true })
        })
      }

      it(`runs pnpm@${PNPM_VERSION}`, async function () {
        if (!semver.satisfies(process.versions.node, pnpmEngines)) {
          // pnpm 11 does not support the oldest Node.js versions the tracer is still tested on.
          this.skip()
        }

        const stdout = await run(entryPoint, ['node_modules/pnpm/bin/pnpm.mjs', '--version'])

        assert.strictEqual(stdout.trim(), PNPM_VERSION)
      })
    })
  }

  // Off-thread hooks rethrow import errors that fail `util.types.isNativeError`, which is what trips
  // pnpm. This keeps the package manager cases above from passing without exercising any hooks.
  it('registers the asynchronous loader hook for applications that only resemble a package manager', async () => {
    const stdout = await run('dd-trace/initialize.mjs', ['package-managers/bin/pnpm-app.mjs'])

    assert.deepStrictEqual(JSON.parse(stdout), { code: 'ERR_MODULE_NOT_FOUND', isNativeError: false })
  })
})
