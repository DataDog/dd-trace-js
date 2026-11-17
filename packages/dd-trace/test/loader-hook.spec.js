'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const repositoryRoot = join(__dirname, '..', '..', '..')
const loaderHookUrl = pathToFileURL(join(repositoryRoot, 'loader-hook.mjs')).href
const configDefaultsPath = join(repositoryRoot, 'packages', 'dd-trace', 'src', 'config', 'defaults.js')

const securityControls = 'SANITIZER:COMMAND_INJECTION:sanitizer/index.js:sanitize'
const sanitizerUrl = 'file:///app/sanitizer/index.js'

describe('initialize.mjs', () => {
  it('initializes ESM instrumentation without deprecated loader warnings', () => {
    const result = initializeEsm()

    assert.doesNotMatch(result.stderr, /\[DEP0205\]/)
    assert.strictEqual(result.status, 0, result.stderr)
    assert.match(result.stdout, /^true\n/)
  })

  it('initializes ESM instrumentation when require(esm) is disabled', function () {
    if (!process.allowedNodeEnvironmentFlags.has('--no-experimental-require-module')) {
      // Older runtimes do not expose require(esm) or its disabling flag.
      this.skip()
    }

    const result = initializeEsm(['--no-experimental-require-module'])

    assert.strictEqual(result.status, 0, result.stderr)
    assert.match(result.stdout, /^true\n/)
  })
})

describe('Lambda loader registration', () => {
  it('initializes synchronous hooks when module.register is unavailable', function () {
    const { supportsSyncHooks } = require('../../../vendor/dist/import-in-the-middle/create-hook')
    if (!supportsSyncHooks()) {
      // Older Node.js releases still use the asynchronous loader.
      this.skip()
    }

    const result = spawnSync(process.execPath, ['--no-experimental-require-module', '--input-type=module', '--eval', `
      import Module from 'node:module'

      const originalRegisterHooks = Module.registerHooks
      let registrations = 0
      Module.registerHooks = (options) => {
        registrations++
        return originalRegisterHooks(options)
      }
      Module.register = undefined
      Module.syncBuiltinESMExports()

      await import(${JSON.stringify(pathToFileURL(join(repositoryRoot, 'initialize.mjs')).href)})
      console.log(registrations)
    `], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '', DD_INJECT_FORCE: 'true', DD_TRACE_STARTUP_LOGS: 'false' },
    })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.strictEqual(result.stdout, '1\n')
    assert.doesNotMatch(result.stderr, /DEP0205|could not register synchronous loader hooks/)
  })

  for (const [entry, fixture] of [
    ['initialize.mjs', 'instrument.js'],
    ['initialize.mjs', 'instrument.mjs'],
    ['register.js', 'instrument.js'],
    ['register.js', 'instrument.mjs'],
  ]) {
    it(`instruments ${fixture} through ${entry} without require(esm) or deprecated hooks`, function () {
      if (!process.allowedNodeEnvironmentFlags.has('--no-experimental-require-module')) {
        // Older Node.js releases do not recognize this flag.
        this.skip()
      }
      // Older Node.js versions still need the asynchronous loader.
      const { supportsSyncHooks } = require('../../../vendor/dist/import-in-the-middle/create-hook')
      if (!supportsSyncHooks()) {
        // Older Node.js releases still use the asynchronous loader.
        this.skip()
      }

      const result = spawnSync(process.execPath, [
        '--no-experimental-require-module',
        '--no-experimental-detect-module',
        ...(entry === 'initialize.mjs'
          ? ['--import', pathToFileURL(join(repositoryRoot, entry)).href]
          : ['--require', join(repositoryRoot, 'init.js'), '--require', join(repositoryRoot, entry)]),
        join(repositoryRoot, 'integration-tests/init', fixture),
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          DD_INJECT_FORCE: 'true',
          DD_TRACE_STARTUP_LOGS: 'false',
        },
      })

      assert.strictEqual(result.status, 0, result.stderr)
      assert.match(result.stdout, /^true\n/)
      assert.doesNotMatch(result.stderr, /DEP0205|could not register synchronous loader hooks/)
    })
  }
})

/**
 * @param {string[]} [execArgv]
 */
function initializeEsm (execArgv = []) {
  return spawnSync(process.execPath, [
    ...execArgv,
    '--import', pathToFileURL(join(repositoryRoot, 'initialize.mjs')).href,
    join(repositoryRoot, 'integration-tests/init/instrument.mjs'),
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      DD_INJECT_FORCE: 'true',
      DD_TRACE_STARTUP_LOGS: 'false',
    },
  })
}

describe('loader hook', () => {
  let temporaryDirectory
  let localConfigPath

  beforeEach(() => {
    // os.tmpdir() could return a falsy value on Windows, if process.env.TEMP or process.env.TMP are malformed.
    temporaryDirectory = mkdtempSync(join(tmpdir() || 'C:\\Windows\\Temp', 'loader-hook-'))
    localConfigPath = join(temporaryDirectory, 'local.yaml')
  })

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true })
  })

  function initializeLoaderHook (env) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { createRequire } from 'node:module'

      const require = createRequire(${JSON.stringify(join(repositoryRoot, 'index.js'))})
      const { initialize } = await import(${JSON.stringify(loaderHookUrl)})
      const data = {}

      await initialize(data)

      console.log(JSON.stringify({
        loadedConfigDefaults: require.cache[${JSON.stringify(configDefaultsPath)}] !== undefined,
        includesSecurityControl: data.shouldInclude(${JSON.stringify(sanitizerUrl)}, './sanitizer/index.js'),
        includesHooklessOrchestrion: data.shouldInclude(
          'file:///app/node_modules/bullmq/dist/esm/classes/queue.js',
          'bullmq'
        ),
        includesHybridOrchestrion: data.shouldInclude(
          'file:///app/node_modules/ai/dist/index.js',
          'ai'
        ),
        pureIncludes: Object.fromEntries(${JSON.stringify([
          '@azure/cosmos',
          '@langchain/core',
          '@langchain/langgraph',
          'bullmq',
          'mercurius',
        ])}.map(name => [name, data.shouldInclude(
          'file:///app/node_modules/' + name + '/dist/index.js',
          name
        )])),
      }))
    `], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DD_IAST_SECURITY_CONTROLS_CONFIGURATION: undefined,
        DD_TEST_LOCAL_CONFIG_PATH: localConfigPath,
        DD_TEST_FLEET_CONFIG_PATH: join(temporaryDirectory, 'fleet.yaml'),
        ...env,
      },
    })

    assert.strictEqual(result.status, 0, result.stderr)

    return JSON.parse(result.stdout)
  }

  it('does not load the configuration defaults when no security controls are configured', () => {
    assert.deepStrictEqual(initializeLoaderHook(), {
      loadedConfigDefaults: false,
      includesSecurityControl: false,
      includesHooklessOrchestrion: false,
      includesHybridOrchestrion: true,
      pureIncludes: {
        '@azure/cosmos': false,
        '@langchain/core': false,
        '@langchain/langgraph': false,
        bullmq: false,
        mercurius: false,
      },
    })
  })

  it('applies security controls from the environment', () => {
    const result = initializeLoaderHook({ DD_IAST_SECURITY_CONTROLS_CONFIGURATION: securityControls })

    assert.strictEqual(result.includesSecurityControl, true)
  })

  it('applies security controls from the PM2 environment', () => {
    const result = initializeLoaderHook({
      pm2_env: JSON.stringify({ DD_IAST_SECURITY_CONTROLS_CONFIGURATION: securityControls }),
    })

    assert.strictEqual(result.includesSecurityControl, true)
  })

  it('applies security controls from stable config', () => {
    writeFileSync(
      localConfigPath,
      `apm_configuration_default:\n  DD_IAST_SECURITY_CONTROLS_CONFIGURATION: "${securityControls}"\n`
    )

    assert.strictEqual(initializeLoaderHook().includesSecurityControl, true)
  })

  it('activates pure modules across the asynchronous loader-worker boundary', () => {
    assert.deepStrictEqual(runPureLoaderPipeline({ version: '5.66.0' }), {
      activations: 1,
      compatibility: ['rewritten'],
      iitmCalls: 0,
      result: 'added',
      sequence: ['activation', 'start'],
      starts: 1,
    })
  })

  it('rewrites ESM dependencies through synchronous hooks when require(esm) is disabled', function () {
    const { supportsSyncHooks } = require('../../../vendor/dist/import-in-the-middle/create-hook')
    if (!supportsSyncHooks()) {
      // Older Node.js releases still use the asynchronous loader.
      this.skip()
    }

    assert.deepStrictEqual(runPureLoaderPipeline({ version: '5.66.0', sync: true }), {
      activations: 1,
      compatibility: ['rewritten'],
      iitmCalls: 0,
      result: 'added',
      sequence: ['activation', 'start'],
      starts: 1,
    })
  })

  it('shares ESM export hooks with the public import-in-the-middle registry', function () {
    const { supportsSyncHooks } = require('../../../vendor/dist/import-in-the-middle/create-hook')
    if (!supportsSyncHooks()) {
      // Older Node.js releases still use the asynchronous loader.
      this.skip()
    }

    const packageDirectory = join(temporaryDirectory, 'node_modules', 'graphql')
    mkdirSync(packageDirectory, { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ type: 'module' }))
    const fixture = join(packageDirectory, 'index.mjs')
    writeFileSync(fixture, 'export function parse () { return "original" }\n')

    const result = spawnSync(process.execPath, ['--no-experimental-require-module', '--eval', `
      const { Hook } = require(${JSON.stringify(require.resolve('import-in-the-middle'))})
      Hook(['graphql'], { internals: true }, exports => {
        exports.parse = () => 'instrumented'
      })
      require(${JSON.stringify(join(repositoryRoot, 'register.js'))})
      import(${JSON.stringify(pathToFileURL(fixture).href)}).then(({ parse }) => console.log(parse()))
    `], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.strictEqual(result.stdout, 'instrumented\n')
    assert.doesNotMatch(result.stderr, /DEP0205|could not register synchronous loader hooks/)
  })

  it('does not rewrite or activate disabled and unsupported pure modules in the asynchronous loader', () => {
    assert.deepStrictEqual(runPureLoaderPipeline({ disabled: true, version: '5.66.0' }), {
      activations: 0,
      compatibility: [],
      iitmCalls: 0,
      result: 'added',
      sequence: [],
      starts: 0,
    })
    assert.deepStrictEqual(runPureLoaderPipeline({ version: '5.65.0' }), {
      activations: 0,
      compatibility: ['unsupported'],
      iitmCalls: 0,
      result: 'added',
      sequence: [],
      starts: 0,
    })
  })

  describe('unwrapped package reports', () => {
    const appUrl = 'file:///app/'

    /**
     * @param {Array<[string, string?]>} loads [loaded URL, format]
     * @param {boolean} withPort
     */
    function loadWithAsyncLoader (loads, withPort = true) {
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
        const { initialize, load, resolve } = await import(${JSON.stringify(loaderHookUrl)})
        const reported = []
        const moduleLoadPort = { unref () {}, postMessage (url) { reported.push(url) } }

        await initialize(${withPort} ? { moduleLoadPort } : {})

        const conditions = ['node', 'import']
        // Resolving without loading, as import.meta.resolve() does, is not a load.
        await resolve('resolved-only', { conditions, parentURL: '${appUrl}index.mjs' }, () => ({
          url: '${appUrl}node_modules/resolved-only/index.js',
          format: 'module',
        }))
        for (const [url, format = 'module'] of ${JSON.stringify(loads)}) {
          await load(url, { conditions, format }, () => ({ format, source: '' }))
        }

        console.log(JSON.stringify(reported))
      `], {
        encoding: 'utf8',
        env: { ...process.env, DD_IAST_SECURITY_CONTROLS_CONFIGURATION: undefined },
      })

      assert.strictEqual(result.status, 0, result.stderr)

      return JSON.parse(result.stdout)
    }

    it('reports the first loaded file of each package from the asynchronous loader', () => {
      const reported = loadWithAsyncLoader([
        [`${appUrl}node_modules/nanoid/index.js`],
        [`${appUrl}node_modules/nanoid/non-secure/index.js`],
        [`${appUrl}node_modules/@scope/first/index.js`],
        [`${appUrl}node_modules/@scope/second/dist/index.js`],
        [`${appUrl}node_modules/parent/node_modules/nested/index.js`],
        [`${appUrl}node_modules/.pnpm/pnpm-package@1.0.0/node_modules/pnpm-package/index.js`],
        [`${appUrl}node_modules/.pnpm/pnpm-package@1.0.0/node_modules/pnpm-package/other.js`],
        // A CommonJS package imported from ESM.
        [`${appUrl}node_modules/cjs-package/index.js`, 'commonjs'],
        // The import-in-the-middle wrapper of an instrumented module.
        [`${appUrl}node_modules/express/index.js?iitm=true`],
        [`${appUrl}local.mjs`],
        ['node:path', 'builtin'],
      ])

      assert.deepStrictEqual(reported, [
        `${appUrl}node_modules/nanoid/index.js`,
        `${appUrl}node_modules/@scope/first/index.js`,
        `${appUrl}node_modules/@scope/second/dist/index.js`,
        `${appUrl}node_modules/parent/node_modules/nested/index.js`,
        `${appUrl}node_modules/.pnpm/pnpm-package@1.0.0/node_modules/pnpm-package/index.js`,
        `${appUrl}node_modules/cjs-package/index.js`,
      ])
    })

    it('does not report without a port', () => {
      assert.deepStrictEqual(loadWithAsyncLoader([[`${appUrl}node_modules/nanoid/index.js`]], false), [])
    })

    it('reports the packages imported through the synchronous loader', function () {
      const nodeModules = join(temporaryDirectory, 'node_modules')
      mkdirSync(join(nodeModules, 'esm-only'), { recursive: true })
      writeFileSync(join(nodeModules, 'esm-only', 'package.json'), JSON.stringify({ type: 'module' }))
      writeFileSync(join(nodeModules, 'esm-only', 'index.js'), 'export default 1\n')
      writeFileSync(join(nodeModules, 'esm-only', 'other.js'), 'export default 2\n')
      mkdirSync(join(nodeModules, 'cjs-only'), { recursive: true })
      writeFileSync(join(nodeModules, 'cjs-only', 'index.js'), 'module.exports = 3\n')
      // An explicit type gives the load hook a known CommonJS format, unlike syntax detection.
      mkdirSync(join(nodeModules, 'cjs-imported'), { recursive: true })
      writeFileSync(join(nodeModules, 'cjs-imported', 'package.json'), JSON.stringify({ type: 'commonjs' }))
      writeFileSync(join(nodeModules, 'cjs-imported', 'index.js'), 'module.exports = 5\n')
      mkdirSync(join(nodeModules, 'resolved-only'), { recursive: true })
      writeFileSync(join(nodeModules, 'resolved-only', 'package.json'), JSON.stringify({ type: 'module' }))
      writeFileSync(join(nodeModules, 'resolved-only', 'index.js'), 'export default 4\n')

      const mainPath = join(temporaryDirectory, 'main.mjs')
      writeFileSync(mainPath, `
        import { createRequire } from 'node:module'

        const require = createRequire(import.meta.url)
        const dc = require(${JSON.stringify(require.resolve('dc-polyfill'))})
        const { registerSyncLoaderHooks } = await import(${JSON.stringify(loaderHookUrl)})

        const reported = []
        dc.channel('dd-trace:moduleLoadStart').subscribe(({ filename }) => {
          reported.push(filename.slice(filename.lastIndexOf('node_modules/')))
        })

        const registered = registerSyncLoaderHooks()
        if (registered) {
          await import('esm-only')
          await import('esm-only/other.js')
          await import('cjs-imported')
          require('cjs-only')
          import.meta.resolve('resolved-only')
        }

        console.log(JSON.stringify({ registered, reported }))
      `)

      const result = spawnSync(process.execPath, [mainPath], { encoding: 'utf8' })
      assert.strictEqual(result.status, 0, result.stderr)
      const { registered, reported } = JSON.parse(result.stdout.trim())

      if (!registered) {
        // Node.js versions without fixed synchronous hooks use the asynchronous loader instead.
        this.skip()
      }

      // require() loads are left to require-in-the-middle, and resolving alone is not a load.
      assert.deepStrictEqual(reported, ['node_modules/esm-only/index.js', 'node_modules/cjs-imported/index.js'])
    })
  })

  function runPureLoaderPipeline ({ disabled = false, version, sync = false }) {
    const packageDirectory = join(temporaryDirectory, 'node_modules', 'bullmq')
    const fixturePath = join(packageDirectory, 'dist', 'esm', 'classes', 'queue.js')
    const mainPath = join(temporaryDirectory, `main-${disabled}-${version}.cjs`)
    mkdirSync(join(packageDirectory, 'dist', 'esm', 'classes'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ type: 'module', version }))
    writeFileSync(fixturePath, 'export class Queue { async add () { return "added" } }\n')
    writeFileSync(mainPath, `
      const { register } = require('node:module')
      const { pathToFileURL } = require('node:url')
      const dc = require(${JSON.stringify(require.resolve('dc-polyfill'))})
      const Hook = require(${JSON.stringify(join(
        repositoryRoot,
        'packages/datadog-instrumentations/src/helpers/hook.js'
      ))})

      require(${JSON.stringify(join(
        repositoryRoot,
        'packages/datadog-instrumentations/src/helpers/register.js'
      ))})
      let iitmCalls = 0
      Hook(['bullmq'], { internals: true }, exports => {
        iitmCalls++
        return exports
      })
      ${sync
        ? `require(${JSON.stringify(join(repositoryRoot, 'register.js'))})`
        : `register(${JSON.stringify(loaderHookUrl)}, pathToFileURL(__filename))`}

      let activations = 0
      const compatibility = []
      let starts = 0
      const sequence = []
      dc.channel('dd-trace:instrumentation:load').subscribe(() => {
        activations++
        sequence.push('activation')
      })
      dc.channel('dd-trace:instrumentation:load:orchestrion').subscribe(({ result }) => {
        compatibility.push(result)
      })
      dc.tracingChannel('orchestrion:bullmq:Queue_add').subscribe({
        start () {
          starts++
          sequence.push('start')
        }
      })

      import(${JSON.stringify(pathToFileURL(fixturePath).href)}).then(async ({ Queue }) => {
        const result = await new Queue().add()
        console.log(JSON.stringify({ activations, compatibility, iitmCalls, result, sequence, starts }))
      })
    `)

    const result = spawnSync(process.execPath, [
      ...(sync ? ['--no-experimental-require-module', '--no-experimental-detect-module'] : []),
      mainPath,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DD_TRACE_DISABLED_INSTRUMENTATIONS: disabled ? 'bullmq' : undefined,
      },
    })
    assert.strictEqual(result.status, 0, result.stderr)
    if (sync) assert.doesNotMatch(result.stderr, /DEP0205|could not register synchronous loader hooks/)
    return JSON.parse(result.stdout.trim())
  }
})
