'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { withDatadogTurbopack } = require('../../../next')

const directories = []

describe('withDatadogTurbopack', () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
  })

  it('exports the wrapper to CommonJS and ESM configurations', async () => {
    const namespace = await import(pathToFileURL(require.resolve('../../../next')).href)

    assert.strictEqual(namespace.withDatadogTurbopack, withDatadogTurbopack)
  })

  it('does not load the code transformer while evaluating the configuration', () => {
    const projectDir = createProject('16.2.0')
    const entryPath = require.resolve('../../../next')
    const transformerPath = require.resolve('../../../vendor/dist/@apm-js-collab/code-transformer')
    const script = `
      const { withDatadogTurbopack } = require(${JSON.stringify(entryPath)})
      withDatadogTurbopack({})('phase-production-build').then(() => {
        process.stdout.write(String(require.cache[${JSON.stringify(transformerPath)}] !== undefined))
      })
    `
    const result = spawnSync(process.execPath, ['-e', script], { cwd: projectDir, encoding: 'utf8' })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'false')
  })

  it('adds non-overlapping modern rules after caller-owned rules', async () => {
    const projectDir = createProject('16.2.0')
    const input = {
      marker: true,
      turbopack: {
        resolveAlias: { existing: './existing.js' },
        rules: {
          '*': [{ loaders: ['catch-all-loader'] }],
          '*.js': { loaders: ['javascript-loader'] },
        },
      },
    }

    const config = await applyConfig(projectDir, input)
    const javascriptRules = config.turbopack.rules['*.js']
    const sourceRule = javascriptRules[1]
    const catchAllRules = config.turbopack.rules['*']
    const extensionlessRule = catchAllRules[1]
    const packagePath = sourceRule.condition.all.find(condition => condition?.path).path
    const extensionlessPath = extensionlessRule.condition.all[3].path

    assert.equal(config.marker, true)
    assert.deepStrictEqual(config.turbopack.resolveAlias, { existing: './existing.js' })
    assert.deepStrictEqual(javascriptRules[0], { loaders: ['javascript-loader'] })
    assert.deepStrictEqual(catchAllRules[0], { loaders: ['catch-all-loader'] })
    assert.deepStrictEqual(sourceRule.condition.all.slice(0, 2), ['node', 'foreign'])
    assert.equal(packagePath.test('/app/node_modules/express/index.js'), true)
    assert.equal(packagePath.test('/app/node_modules/.pnpm/ai@6.0.0/node_modules/ai/dist/index.mjs'), true)
    assert.equal(packagePath.test('/app/node_modules/unrelated/index.js'), false)
    assert.equal(extensionlessPath.test('/app/node_modules/ioredis/runner'), true)
    assert.equal(extensionlessPath.test('/app/node_modules/ioredis/runner.js'), false)
    assert.equal(extensionlessPath.test('/app/node_modules/ioredis/package.json'), false)
    assert.equal(extensionlessPath.test('/app/node_modules/ioredis/native.node'), false)
    assert.equal(extensionlessRule.as, '*.__dd_trace_turbopack.js')
    assert.equal(typeof sourceRule.loaders[0].loader, 'string')
    assert.deepStrictEqual(sourceRule.loaders[0].options, {})
  })

  it('uses one named foreign-module rule for Next 15', async () => {
    const projectDir = createProject('15.5.0')
    const config = await applyConfig(projectDir, {
      turbopack: {
        conditions: { existing: { path: /existing/ } },
        rules: { existing: { node: { loaders: ['existing-loader'] } } },
      },
    })
    const name = '#dd-trace/modules'
    const condition = config.turbopack.conditions[name]
    const rule = config.turbopack.rules[name]
    const packagePath = condition.all[0].path
    const [source, extensionless] = condition.all[1].any

    assert.ok(config.turbopack.conditions.existing)
    assert.ok(config.turbopack.rules.existing)
    assert.equal(packagePath.test('/app/node_modules/express/index.js'), true)
    assert.equal(packagePath.test('/app/node_modules/unrelated/index.js'), false)
    assert.equal(source.path.test('/app/node_modules/express/index.js'), true)
    assert.equal(extensionless.path.test('/app/node_modules/ioredis/runner'), true)
    assert.equal(source.path.test('/app/node_modules/express/package.json'), false)
    assert.equal(extensionless.path.test('/app/node_modules/express/package.json'), false)
    assert.equal(source.path.test('/app/node_modules/native/addon.node'), false)
    assert.equal(extensionless.path.test('/app/node_modules/native/addon.node'), false)
    assert.equal(typeof rule.node.foreign.loaders[0].loader, 'string')
    assert.deepStrictEqual(rule.node.foreign.loaders[0].options, {})
    assert.equal(rule.condition, undefined)
  })

  it('is idempotent and rejects a caller-owned legacy condition', async () => {
    const modernProject = createProject('16.2.0')
    const configured = await applyConfig(modernProject, {})
    const repeated = await applyConfig(modernProject, configured)

    assert.strictEqual(repeated, configured)

    const legacyProject = createProject('15.5.0')
    await assert.rejects(
      applyConfig(legacyProject, { turbopack: { conditions: { '#dd-trace/modules': {} } } }),
      /already uses the reserved condition #dd-trace\/modules/
    )
  })

  it('supports object, promise, and function configs without changing the server phase', async () => {
    const projectDir = createProject('16.2.0')
    const promisedInput = { promised: true }
    const receiver = { calls: 0 }
    const [promised, functional, undefinedConfig] = withProjectDirectory(projectDir, () => [
      withDatadogTurbopack(Promise.resolve(promisedInput)),
      withDatadogTurbopack(function (phase) {
        this.calls++
        assert.equal(phase, 'phase-production-build')
        return { functional: true }
      }),
      withDatadogTurbopack(() => undefined),
    ])

    const [promisedResult, functionalResult, undefinedResult] = await Promise.all([
      promised('phase-production-build'),
      functional.call(receiver, 'phase-production-build'),
      undefinedConfig('phase-production-build'),
    ])
    const serverInput = { server: true }
    const serverConfig = withProjectDirectory(projectDir, () => withDatadogTurbopack(serverInput))

    assert.equal(promisedResult.promised, true)
    assert.ok(promisedResult.turbopack.rules['*.js'])
    assert.equal(receiver.calls, 1)
    assert.equal(functionalResult.functional, true)
    assert.ok(undefinedResult.turbopack.rules['*.js'])
    assert.strictEqual(await serverConfig('phase-production-server'), serverInput)
  })

  it('validates config shapes and the supported Next.js boundary', async () => {
    const projectDir = createProject('16.2.0')
    const invalid = [
      false,
      [],
      { turbopack: false },
      { turbopack: { conditions: [] } },
      { turbopack: { rules: [] } },
    ]

    for (const value of invalid) {
      await assert.rejects(applyConfig(projectDir, value), TypeError)
    }

    const unsupportedProject = createProject('15.4.9')
    assert.throws(
      () => withProjectDirectory(unsupportedProject, () => withDatadogTurbopack({})),
      /requires Next\.js 15\.5 or newer; found 15\.4\.9/
    )
  })

  it('resolves Next.js from the active CLI when building another directory', async () => {
    const projectDir = createProject('15.5.0')
    const cli = path.join(projectDir, 'node_modules', 'next', 'dist', 'bin', 'next')
    const wrapped = withMainFilename(cli, () => withDatadogTurbopack({}))

    const config = await wrapped('phase-production-build')

    assert.ok(config.turbopack.rules['#dd-trace/modules'])
  })
})

/**
 * @param {string} version
 * @returns {string}
 */
function createProject (version) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-turbopack-'))
  directories.push(projectDir)
  const nextDirectory = path.join(projectDir, 'node_modules', 'next')
  fs.mkdirSync(nextDirectory, { recursive: true })
  fs.writeFileSync(path.join(nextDirectory, 'package.json'), JSON.stringify({ name: 'next', version }))
  return projectDir
}

/**
 * @param {string} projectDir
 * @param {unknown} input
 * @returns {Promise<object>}
 */
function applyConfig (projectDir, input) {
  const wrapped = withProjectDirectory(projectDir, () => withDatadogTurbopack(input))
  return wrapped('phase-production-build')
}

/**
 * @template TResult
 * @param {string} projectDir
 * @param {() => TResult} callback
 * @returns {TResult}
 */
function withProjectDirectory (projectDir, callback) {
  const previousDirectory = process.cwd()
  try {
    process.chdir(projectDir)
    return callback()
  } finally {
    process.chdir(previousDirectory)
  }
}

/**
 * @template TResult
 * @param {string} filename
 * @param {() => TResult} callback
 * @returns {TResult}
 */
function withMainFilename (filename, callback) {
  const previousFilename = require.main.filename
  try {
    require.main.filename = filename
    return callback()
  } finally {
    require.main.filename = previousFilename
  }
}
