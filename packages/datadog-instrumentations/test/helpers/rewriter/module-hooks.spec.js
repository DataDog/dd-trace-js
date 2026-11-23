'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

const { NODE_MAJOR, NODE_MINOR } = require('../../../../../version')
const { isSyncLoaderHookVersionSupported } = require('../../../../dd-trace/src/sync-loader-hooks')

const repositoryRoot = join(__dirname, '..', '..', '..', '..', '..')
const fixtureDirectory = join(__dirname, 'fixtures', 'module-hooks')
const initPath = join(repositoryRoot, 'init.js')
const registerPath = join(repositoryRoot, 'register.js')
const initializePath = join(repositoryRoot, 'initialize.mjs')
const otherLoaderPath = join(fixtureDirectory, 'other-loader.mjs')
const passthroughLoaderPath = join(fixtureDirectory, 'passthrough-loader.mjs')
const countRewritesPath = join(fixtureDirectory, 'count-rewrites.js')

// Each target in the fixture publishes one activation per evaluated rewrite: the CommonJS bullmq queue, and the
// postgres 4 pool imported by the ES module entrypoint, which has no transform of its own.
const rewritten = { commonjs: ['rewritten'], postgres: ['rewritten', 'unsupported'] }
// The tracer's synchronous hook sees the files imported by an ES module loaded through require(). So does the
// asynchronous loader that register.js falls back to, from Node.js 22.15 on.
const syncHooksSupported = isSyncLoaderHookVersionSupported()
const asyncLoaderRewritesRequireEsm = NODE_MAJOR > 22 || NODE_MINOR >= 15

describe('rewriter module hooks', () => {
  before(function () {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    if (!process.features.require_module) {
      // The fixture loads postgres 4, an ES module, through require().
      this.skip()
    }
  })

  describe('in a CommonJS app with -r dd-trace/init', () => {
    it('rewrites CommonJS targets', () => {
      assert.deepStrictEqual(runApp('app.js', ['-r', initPath]).commonjs, rewritten.commonjs)
    })

    it('rewrites the files that an ES module loaded through require() imports', function () {
      if (!syncHooksSupported) {
        // Without synchronous hooks, -r dd-trace/init alone rewrites CommonJS only.
        this.skip()
      }

      assert.deepStrictEqual(runApp('app.js', ['-r', initPath]).postgres, rewritten.postgres)
    })

    it('rewrites them with another vendor\'s --loader', function () {
      if (!syncHooksSupported) {
        // Without synchronous hooks, -r dd-trace/init alone rewrites CommonJS only.
        this.skip()
      }

      const result = runApp('app.js', ['--no-warnings', '--loader', passthroughLoaderPath, '-r', initPath])

      assert.deepStrictEqual(result, { commonjs: rewritten.commonjs, postgres: rewritten.postgres })
    })

    it('rewrites each file once with --import dd-trace/register.js', () => {
      const result = runApp('app.js', ['-r', initPath, '--import', registerPath])

      assert.deepStrictEqual(result, {
        commonjs: rewritten.commonjs,
        postgres: syncHooksSupported || asyncLoaderRewritesRequireEsm ? rewritten.postgres : ['unsupported'],
      })
    })

    describe('importing an ES module target that import-in-the-middle wraps', () => {
      before(function () {
        if (!syncHooksSupported) {
          // The count covers the application thread only, where the synchronous hooks rewrite.
          this.skip()
        }
      })

      const setups = {
        '-r dd-trace/init': ['-r', initPath],
        '-r dd-trace/init and --import dd-trace/register.js': ['-r', initPath, '--import', registerPath],
        '--import dd-trace/initialize.mjs': ['--import', initializePath],
      }

      for (const [name, execArgv] of Object.entries(setups)) {
        it(`transforms it once with ${name}`, () => {
          const counts = runApp('hybrid-app.js', ['-r', countRewritesPath, ...execArgv])

          assert.deepStrictEqual(counts, { 'ai/dist/index.mjs': 1 })
        })
      }
    })
  })

  describe('in an ES module app importing a CommonJS target', () => {
    const setups = {
      '--import dd-trace/register.js with -r dd-trace/init': ['--import', registerPath, '-r', initPath],
      '--import dd-trace/initialize.mjs': ['--import', initializePath],
    }

    for (const [name, execArgv] of Object.entries(setups)) {
      it(`rewrites it once with ${name}`, () => {
        assert.deepStrictEqual(runApp('esm-app.mjs', execArgv), { commonjs: rewritten.commonjs })
      })

      // Beside an asynchronous loader, synchronous hooks receive imported CommonJS without source.
      it(`rewrites it once with ${name} and another module.register loader`, () => {
        const result = runApp('esm-app.mjs', ['--import', otherLoaderPath, ...execArgv])

        assert.deepStrictEqual(result, { commonjs: rewritten.commonjs })
      })
    }
  })
})

/**
 * @param {string} app
 * @param {string[]} execArgv
 */
function runApp (app, execArgv) {
  const { error, status, stderr, stdout } = spawnSync(process.execPath, [
    ...execArgv,
    join(fixtureDirectory, app),
  ], {
    cwd: fixtureDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      DD_INJECT_FORCE: 'true',
      DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
      DD_REMOTE_CONFIGURATION_ENABLED: 'false',
      DD_TRACE_STARTUP_LOGS: 'false',
    },
    timeout: 20_000,
  })

  assert.ifError(error)
  assert.strictEqual(status, 0, stderr)

  return JSON.parse(stdout)
}
