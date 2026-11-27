'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { ignores: ['module.register'] }] */

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { register } = require('node:module')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

const { isSyncLoaderHookVersionSupported } = require('../../../../dd-trace/src/register-loader')

const root = resolve(__dirname, '../../../../..')
const fixture = join(__dirname, 'fixtures', 'require-esm')
const init = join(root, 'init.js')
const loaderUrl = pathToFileURL(join(root, 'loader-hook.mjs')).href
const registerPath = join(root, 'register.js')
const passThroughLoader = 'data:text/javascript,export async function load(url, context, nextLoad) {' +
  'return nextLoad(url, context)}'

describe('rewriting ES modules loaded through require()', () => {
  before(function () {
    if (!isSyncLoaderHookVersionSupported()) {
      // Older Node.js releases cannot safely compose sync hooks with async loaders.
      this.skip()
    }
  })

  it('rewrites the entry and its static dependencies with only -r dd-trace/init', () => {
    assert.deepStrictEqual(run(['-r', init], "require('postgres')"), ['rewritten', 'unsupported'])
  })

  it('rewrites each target once when the explicit sync loader is already registered', () => {
    assert.deepStrictEqual(
      run(['-r', init, '--import', registerPath], "require('postgres')"),
      ['rewritten', 'unsupported']
    )
  })

  it('rewrites each target once when dd-trace falls back to its async loader', function () {
    if (!register) {
      // Newer Node.js releases no longer have the async loader API.
      this.skip()
    }

    const preload = 'data:text/javascript,import Module from "node:module";' +
      'const registerHooks = Module.registerHooks; delete Module.registerHooks;' +
      `await import(${JSON.stringify(pathToFileURL(registerPath).href)});` +
      'Module.registerHooks = registerHooks'
    assert.deepStrictEqual(
      run(['-r', init, '--import', preload], "require('postgres')"),
      ['rewritten', 'unsupported']
    )
  })

  it('rewrites each target once and keeps the inline source map last with --loader', function () {
    if (!process.allowedNodeEnvironmentFlags.has('--loader')) {
      // Newer Node.js releases no longer support the legacy loader flag.
      this.skip()
    }

    assert.deepStrictEqual(
      run(['-r', init, '--loader', loaderUrl, '--enable-source-maps'], `
        const assert = require('node:assert/strict')
        const { findSourceMap, registerHooks } = require('node:module')
        const { pathToFileURL } = require('node:url')
        const poolPath = require.resolve('./node_modules/postgres/src/pool.js')
        const poolUrl = pathToFileURL(poolPath).href
        let sawPool = false
        registerHooks({
          load (url, context, nextLoad) {
            const result = nextLoad(url, context)
            if (url === poolUrl) {
              sawPool = true
              assert.ok(result.source.split('\\n').at(-1).startsWith('//# sourceMappingURL=data:'))
            }
            return result
          },
        })

        require('./imports-postgres.mjs')
        assert.ok(sawPool)
        assert.ok(findSourceMap(poolPath))
      `),
      ['rewritten', 'unsupported']
    )
  })

  it('rewrites each target once with a directly registered Datadog async loader', function () {
    if (!register) {
      // Newer Node.js releases no longer have the async loader API.
      this.skip()
    }

    const preload = 'data:text/javascript,import { register } from "node:module";' +
      `register(${JSON.stringify(loaderUrl)})`
    assert.deepStrictEqual(
      run(['-r', init, '--import', preload], "require('postgres')"),
      ['rewritten', 'unsupported']
    )
  })

  it('still rewrites static dependencies with a third-party async loader', function () {
    if (!register) {
      // Newer Node.js releases no longer have the async loader API.
      this.skip()
    }

    const preload = 'data:text/javascript,import { register } from "node:module";' +
      `register(${JSON.stringify(passThroughLoader)})`
    assert.deepStrictEqual(
      run(['-r', init, '--import', preload], "require('postgres')"),
      ['rewritten', 'unsupported']
    )
  })

  it('rewrites a nested require(esm) once and leaves no hook behind when evaluation throws', () => {
    assert.deepStrictEqual(run(['-r', init], `
      const assert = require('node:assert/strict')
      assert.throws(() => require('./throws.mjs'), { message: 'application error' })
      await import('./node_modules/postgres/src/pool.js?after')
    `), ['rewritten', 'unsupported'])
  })

  it('does not rewrite standalone imports with only -r dd-trace/init', () => {
    assert.deepStrictEqual(run(['-r', init], "await import('postgres')"), [])
  })
})

/**
 * @param {string[]} preloads
 * @param {string} app
 */
function run (preloads, app) {
  const { error, status, stderr, stdout } = spawnSync(process.execPath, [
    ...preloads,
    '--input-type=commonjs',
    '--eval',
    `
      const results = []
      require('dc-polyfill').channel('dd-trace:instrumentation:load:orchestrion').subscribe(event => {
        if (event.moduleName === 'postgres') results.push(event.result)
      })
      async function main () {
        ${app}
        console.log(JSON.stringify(results))
      }
      main().catch(error => {
        console.error(error)
        process.exitCode = 1
      })
    `,
  ], {
    cwd: fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      DD_INJECT_FORCE: 'true',
      DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
      DD_REMOTE_CONFIGURATION_ENABLED: 'false',
      DD_TRACE_STARTUP_LOGS: 'false',
    },
    timeout: 10_000,
  })

  assert.ifError(error)
  assert.strictEqual(status, 0, stderr)
  return JSON.parse(stdout)
}
