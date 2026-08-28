'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { withDatadogTurbopack } = require('../../../next')
const hooks = require('../../datadog-instrumentations/src/helpers/hooks')
const instrumentations = require('../../datadog-instrumentations/src/helpers/instrumentations')
const {
  cleanup,
  createPackage,
  createProject,
  findDatadogLoaders,
  write,
} = require('./helpers')

afterEach(() => {
  cleanup()
  sinon.restore()
})

describe('withDatadogTurbopack', () => {
  it('exports the wrapper to CommonJS and ESM configurations', async () => {
    const namespace = await import(pathToFileURL(require.resolve('../../../next')).href)

    assert.strictEqual(namespace.withDatadogTurbopack, withDatadogTurbopack)
  })

  it('discovers integrations independently of build-process disablement', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packageDir, 'index.js', 'module.exports = {}')
    const previous = process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
    process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'ioredis'

    try {
      const config = await withDatadogTurbopack({}, { projectDir })
      assert.ok(config.turbopack.rules['*.js'])
    } finally {
      if (previous === undefined) delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
      else process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = previous
    }
  })

  it('uses Next 16 rule conditions and preserves existing configuration', async () => {
    const projectDir = createProject('16.2.0')
    const packageDir = createPackage(projectDir, 'ai', { main: 'index.mjs', type: 'module', version: '7.0.0' })
    write(packageDir, 'index.mjs', [
      'export function generateText () {}',
      'export function streamText () {}',
      '',
    ].join('\n'))
    const input = {
      marker: true,
      turbopack: {
        resolveAlias: { existing: './existing.js' },
        rules: {
          '*.cjs': [{ loaders: ['existing-array-loader'] }],
          '*.js': { loaders: ['existing-loader'] },
        },
      },
    }

    const config = await withDatadogTurbopack(input, { projectDir })
    const rules = config.turbopack.rules['*.js']
    const targetRule = rules.find(rule => rule.condition?.all?.some(condition => condition?.any))
    const importRule = rules.find(rule => rule.condition?.all?.some(condition => condition?.content))

    assert.equal(config.marker, true)
    assert.equal(config.turbopack.resolveAlias.existing, './existing.js')
    assert.deepEqual(rules[0], { loaders: ['existing-loader'] })
    assert.deepEqual(config.turbopack.rules['*.cjs'][0], { loaders: ['existing-array-loader'] })
    assert.equal(targetRule.condition.all[0], 'node')
    assert.equal(targetRule.condition.all[1].any.length, 2)
    assert.equal(importRule.condition.all[0], 'node')
    assert.equal(importRule.condition.all.some(condition => condition?.not === 'foreign'), true)
    assert.equal(importRule.loaders[0].options.rewriteEdges, true)
    assert.equal(importRule.loaders[0].options.targetScope, undefined)
    assert.equal(targetRule.loaders[0].options.rewriteEdges, true)
    assert.equal(targetRule.loaders[0].options.targetScope, 'direct')
    const contentPattern = importRule.condition.all.find(condition => condition?.content).content
    assert.equal(contentPattern.test("import /* webpackChunkName: 'ai' */ ('ai')"), true)
    assert.equal(contentPattern.test('const answer = 42'), false)
  })

  it('uses named conditions and nested built-ins for Next 15', async () => {
    const projectDir = createProject('15.5.0')
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packageDir, 'index.js', 'module.exports = {}')
    const aiDirectory = createPackage(projectDir, 'ai', { main: 'index.mjs', type: 'module', version: '7.0.0' })
    write(aiDirectory, 'index.mjs', 'export function generateText () {}\n')
    const prismaDirectory = createPackage(projectDir, '@prisma/client', { main: 'index.js', version: '6.1.0' })
    write(prismaDirectory, 'index.js', 'module.exports = {}')
    write(prismaDirectory, 'runtime/library.js', 'module.exports = {}\n')

    const config = await withDatadogTurbopack({}, { projectDir })
    const name = '#dd-trace/target'
    const rule = config.turbopack.rules[name]
    const loader = rule.node.loaders[0]

    assert.ok(config.turbopack.conditions[name].path instanceof RegExp)
    assert.equal(config.turbopack.conditions[name].path.test('/app/node_modules/ioredis/index.js'), true)
    assert.equal(config.turbopack.conditions[name].path.test('/app/node_modules/ioredis/package.json'), false)
    assert.equal(Object.keys(config.turbopack.conditions).length, 3)
    assert.ok(config.turbopack.conditions['#dd-trace/import'].content instanceof RegExp)
    assert.ok(config.turbopack.conditions['#dd-trace/relative'].path instanceof RegExp)
    assert.equal(config.turbopack.rules['#dd-trace/import'].node.foreign, false)
    assert.equal(config.turbopack.rules['#dd-trace/import'].node.loaders.length, 1)
    assert.equal(config.turbopack.rules['#dd-trace/import'].node.loaders[0].options.rewriteEdges, true)
    assert.equal(config.turbopack.rules['#dd-trace/relative'].node.foreign, false)
    assert.equal(config.turbopack.rules['#dd-trace/relative'].node.loaders[0].options.targetScope, 'relative')
    assert.equal(rule.condition, undefined)
    assert.equal(typeof loader.loader, 'string')
    assert.match(loader.options.manifestHash, /^[a-f\d]{64}$/)
    JSON.stringify(loader.options)

    const repeated = await withDatadogTurbopack(config, { projectDir })
    assert.equal(findDatadogLoaders(repeated).length, findDatadogLoaders(config).length)
  })

  it('leaves newer Next majors on the modern schema path', async () => {
    const projectDir = createProject('17.0.0-canary.1')
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packageDir, 'index.js', 'module.exports = {}')

    const config = await withDatadogTurbopack({}, { projectDir })

    assert.equal([config.turbopack.rules['*.js']].flat().every(rule => rule.condition), true)
    assert.equal(config.turbopack.conditions, undefined)
  })

  it('supports object promises and config functions without changing their contract', async () => {
    const projectDir = createProject()
    const promisedConfig = { promised: true }
    const promiseResult = await withDatadogTurbopack(Promise.resolve(promisedConfig), { projectDir })
    const receiver = { calls: 0 }
    const defaultConfig = { defaultConfig: true }
    const wrapped = withDatadogTurbopack(function (phase, context) {
      this.calls++
      assert.equal(phase, 'phase-production-build')
      assert.strictEqual(context.defaultConfig, defaultConfig)
      return { functional: true }
    }, { projectDir })
    const wrappedUndefined = withDatadogTurbopack(() => undefined, { projectDir })

    const [functionResult, undefinedResult] = await Promise.all([
      wrapped.call(receiver, 'phase-production-build', { defaultConfig }),
      wrappedUndefined(),
    ])

    assert.strictEqual(promiseResult, promisedConfig)
    assert.equal(receiver.calls, 1)
    assert.deepEqual(functionResult, { functional: true })
    assert.deepEqual(undefinedResult, {})
  })

  it('uses the current directory when no project option is provided', async () => {
    const projectDir = createProject()
    const previousDirectory = process.cwd()

    try {
      process.chdir(projectDir)
      assert.deepEqual(await withDatadogTurbopack(), {})
    } finally {
      process.chdir(previousDirectory)
    }
  })

  it('returns the original object when no supported package is installed', async () => {
    const projectDir = createProject()
    const config = { turbopack: { resolveAlias: { value: './value.js' } } }

    assert.strictEqual(await withDatadogTurbopack(config, { projectDir }), config)
    assert.equal(fs.existsSync(path.join(projectDir, 'node_modules/.cache/dd-trace/turbopack')), false)
  })

  it('creates one immutable plan under concurrent and repeated composition', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packageDir, 'index.js', 'module.exports = {}')

    const configs = await Promise.all([
      withDatadogTurbopack({}, { projectDir }),
      withDatadogTurbopack({}, { projectDir }),
      withDatadogTurbopack({}, { projectDir }),
      withDatadogTurbopack({}, { projectDir }),
    ])
    const planPaths = configs.map(config => findDatadogLoaders(config)[0].options.manifestPath)
    const twice = await withDatadogTurbopack(configs[0], { projectDir })

    assert.equal(new Set(planPaths).size, 1)
    assert.match(planPaths[0], /\/[a-f\d]{64}\/[a-f\d]{64}\.json$/)
    assert.equal(
      path.basename(planPaths[0], '.json'),
      createHash('sha256').update(fs.readFileSync(planPaths[0])).digest('hex')
    )
    assert.equal(findDatadogLoaders(twice).length, findDatadogLoaders(configs[0]).length)
    assert.equal(fs.readdirSync(path.dirname(path.dirname(planPaths[0]))).length, 1)
  })

  it('reports one warning for instrumentation discovery and target compilation failures', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packageDir, 'index.js', 'module.exports = {}')
    const aiDirectory = createPackage(projectDir, 'ai', { main: 'index.mjs', type: 'module', version: '7.0.0' })
    write(aiDirectory, 'index.mjs', 'export {')
    const emitWarning = sinon.stub(process, 'emitWarning')
    const hookName = 'test-turbopack-load-failure'
    const skippedHookName = 'test-turbopack-nonfunction-hook'
    hooks[hookName] = () => {
      throw new Error('load failed')
    }
    hooks[skippedHookName] = {}

    try {
      await withDatadogTurbopack({}, { projectDir })
      await withDatadogTurbopack({}, { projectDir })
    } finally {
      delete hooks[hookName]
      delete hooks[skippedHookName]
    }

    assert.equal(emitWarning.callCount, 2)
    sinon.assert.calledWithMatch(emitWarning, /Could not load the test-turbopack-load-failure instrumentation/)
    sinon.assert.calledWithMatch(emitWarning, new RegExp(`Could not instrument ${aiDirectory}`))
  })

  it('wraps cache-directory creation failures with their build path', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packageDir, 'index.js', 'module.exports = {}')
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    sinon.stub(fsPromises, 'mkdir').rejects(error)

    await assert.rejects(
      withDatadogTurbopack({}, { projectDir }),
      { message: /Could not create the Datadog Turbopack cache .*permission denied/ }
    )
  })

  it('accepts an artifact completed by a concurrent build-plan writer', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packageDir, 'index.js', 'module.exports = {}')
    const link = fsPromises.link.bind(fsPromises)
    sinon.stub(fsPromises, 'link').callsFake(async (source, target) => {
      await link(source, target)
      throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
    })

    const config = await withDatadogTurbopack({}, { projectDir })

    assert.ok(config.turbopack.rules['*.js'])
  })

  it('rejects conflicting and failed artifact writes', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packageDir, 'index.js', 'module.exports = {}')
    const link = fsPromises.link.bind(fsPromises)
    sinon.stub(fsPromises, 'link').callsFake(async (source, target) => {
      await link(source, target)
      await fsPromises.writeFile(target, 'conflict')
      throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
    })

    await assert.rejects(
      withDatadogTurbopack({}, { projectDir }),
      { message: /artifact .* does not match its content address/ }
    )

    sinon.restore()
    const failedProject = createProject()
    const failedPackage = createPackage(failedProject, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(failedPackage, 'index.js', 'module.exports = {}')
    sinon.stub(fsPromises, 'link').rejects(Object.assign(new Error('link denied'), { code: 'EACCES' }))

    await assert.rejects(withDatadogTurbopack({}, { projectDir: failedProject }), { message: /link denied/ })
  })

  it('warns when a temporary artifact cannot be removed', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packageDir, 'index.js', 'module.exports = {}')
    const emitWarning = sinon.stub(process, 'emitWarning')
    sinon.stub(fsPromises, 'unlink').rejects(new Error('unlink denied'))

    const config = await withDatadogTurbopack({}, { projectDir })

    assert.ok(config.turbopack.rules['*.js'])
    sinon.assert.calledWithMatch(emitWarning, /Could not remove temporary Turbopack artifact .*unlink denied/)
  })

  it('rejects an existing artifact whose content no longer matches its address', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packageDir, 'index.js', 'module.exports = {}')
    const config = await withDatadogTurbopack({}, { projectDir })
    const planPath = findDatadogLoaders(config)[0].options.manifestPath
    fs.writeFileSync(planPath, 'conflict')

    await assert.rejects(
      withDatadogTurbopack({}, { projectDir }),
      { message: /artifact .* does not match its content address/ }
    )
  })

  it('discovers nested copies and records exact instrumentation indexes', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'parent/node_modules/ioredis', {
      main: 'index.js',
      version: '5.0.0',
    })
    const target = write(packageDir, 'index.js', 'module.exports = {}')

    const config = await withDatadogTurbopack({}, { projectDir })
    const planPath = findDatadogLoaders(config)[0].options.manifestPath
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
    const entry = plan.targets[fs.realpathSync(target).replaceAll('\\', '/')]

    assert.equal(entry.payloads[0].package, 'ioredis')
    assert.deepEqual(entry.payloads[0].instrumentationIndexes, [3])
  })

  it('discovers dependencies resolved from an ancestor project', async () => {
    const projectRoot = createProject()
    const packageDir = createPackage(projectRoot, 'ioredis', {
      main: 'dist/index.js',
      version: '5.0.0',
    })
    write(packageDir, 'dist/index.js', 'module.exports = {}')
    const projectDir = path.join(projectRoot, 'app')
    write(projectDir, 'package.json', '{}')

    const config = await withDatadogTurbopack({}, { projectDir })

    assert.ok(config.turbopack.rules['*.js'])
  })

  it('discovers linked workspace dependencies outside node_modules', async () => {
    const workspaceDir = createProject()
    const projectDir = path.join(workspaceDir, 'apps/web')
    write(projectDir, 'package.json', '{}')
    const packageDir = path.join(workspaceDir, 'packages/cache-client')
    write(packageDir, 'package.json', JSON.stringify({ main: 'index.js', name: 'ioredis', version: '5.0.0' }))
    const target = write(packageDir, 'index.js', 'module.exports = {}')
    fs.symlinkSync(packageDir, path.join(workspaceDir, 'node_modules/ioredis'), 'dir')

    const config = await withDatadogTurbopack({}, { projectDir })
    const targetRule = [config.turbopack.rules['*.js']].flat().find(
      rule => rule.condition?.all?.some(condition => condition?.any)
    )
    const planPath = findDatadogLoaders(config)[0].options.manifestPath
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))

    assert.ok(plan.targets[fs.realpathSync(target).replaceAll('\\', '/')])
    assert.equal(
      targetRule.condition.all[1].any.some(({ path: pattern }) =>
        pattern.test('../../packages/cache-client/index.js')),
      true
    )
  })

  it('discovers dependencies in a pnpm virtual store', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, '.pnpm/ioredis@5.0.0/node_modules/ioredis', {
      main: 'index.js',
      version: '5.0.0',
    })
    write(packageDir, 'index.js', 'module.exports = {}')
    const hoistedPackage = createPackage(projectDir, '.pnpm/node_modules/ioredis', {
      main: 'index.js',
      version: '5.0.0',
    })
    write(hoistedPackage, 'index.js', 'module.exports = {}')
    write(projectDir, 'node_modules/.pnpm/not-a-package', 'file')

    const config = await withDatadogTurbopack({}, { projectDir })
    const planPath = findDatadogLoaders(config)[0].options.manifestPath
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))

    assert.ok(plan.targets[fs.realpathSync(path.join(packageDir, 'index.js')).replaceAll('\\', '/')])
  })

  it('handles package-boundary traversal failures without losing valid targets', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packageDir, 'index.js', 'module.exports = {}')
    write(packageDir, 'node_modules', 'not a directory')
    fs.mkdirSync(path.join(projectDir, 'node_modules', '.bin'))
    write(projectDir, 'node_modules/not-a-package', 'file')
    const scopeDirectory = path.join(projectDir, 'node_modules', '@scope')
    fs.mkdirSync(scopeDirectory)
    write(scopeDirectory, 'not-a-package', 'file')
    fs.symlinkSync(packageDir, path.join(projectDir, 'node_modules', 'ioredis-alias'), 'dir')
    fs.symlinkSync(
      path.join(projectDir, 'node_modules', 'missing'),
      path.join(projectDir, 'node_modules', 'broken-link'),
      'dir'
    )
    fs.symlinkSync(
      path.join(projectDir, 'node_modules', 'not-a-package'),
      path.join(projectDir, 'node_modules', '@broken'),
      'dir'
    )
    fs.symlinkSync(
      path.join(projectDir, 'node_modules', 'not-a-package'),
      path.join(projectDir, 'node_modules', '.pnpm'),
      'dir'
    )

    const config = await withDatadogTurbopack({}, { projectDir })

    assert.ok(config.turbopack.rules['*.js'])
  })

  it('skips invalid package metadata and file patterns', async () => {
    const projectDir = createProject()
    const invalidPackage = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(invalidPackage, 'package.json', '{')

    assert.deepEqual(await withDatadogTurbopack({}, { projectDir }), {})

    const validProject = createProject()
    const validPackage = createPackage(validProject, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(validPackage, 'index.js', 'module.exports = {}')
    const load = hooks.ioredis?.fn ?? hooks.ioredis
    load()
    const entries = instrumentations.ioredis
    entries.push({ filePattern: '[', hook () {}, versions: ['>=5'] })

    try {
      const config = await withDatadogTurbopack({}, { projectDir: validProject })
      assert.ok(config.turbopack.rules['*.js'])
    } finally {
      entries.pop()
    }

    const fallbackProject = createProject()
    const fallbackPackage = createPackage(fallbackProject, 'ioredis', {
      exports: { './commands': './index.js' },
      main: 'index.js',
      version: '5.0.0',
    })
    write(fallbackPackage, 'index.js', 'module.exports = {}')

    const fallbackConfig = await withDatadogTurbopack({}, { projectDir: fallbackProject })
    assert.ok(fallbackConfig.turbopack.rules['*.js'])
  })

  it('deduplicates relative hooks and rejects ambiguous package versions', async () => {
    const projectDir = createProject()
    const first = createPackage(projectDir, '@prisma/client', { main: 'index.js', version: '6.1.0' })
    const second = createPackage(projectDir, 'parent/node_modules/@prisma/client', {
      main: 'index.js',
      version: '6.1.0',
    })
    write(first, 'index.js', 'module.exports = {}')
    write(first, 'runtime/library.js', 'module.exports = { copy: 1 }\n')
    write(second, 'index.js', 'module.exports = {}')
    write(second, 'runtime/library.js', 'module.exports = { copy: 2 }\n')
    const load = hooks['@prisma/client']?.fn ?? hooks['@prisma/client']
    load()
    const relativeEntries = instrumentations['./runtime/library.js']
    relativeEntries.push({ ...relativeEntries[0] })
    relativeEntries.push({ hook () {}, versions: ['>=6.1.0 <7.0.0'] })

    try {
      const config = await withDatadogTurbopack({}, { projectDir })
      const planPath = findDatadogLoaders(config)[0].options.manifestPath
      const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))

      assert.equal(plan.relativeTargets.length, 2)
      assert.deepEqual(plan.relativeTargets[0].payloads[0].instrumentationIndexes, [0, 1])
      assert.deepEqual(plan.relativeTargets[1].payloads[0].instrumentationIndexes, [0, 1])
    } finally {
      relativeEntries.splice(-2)
    }

    const ambiguousProject = createProject()
    for (const [parent, version] of [['', '6.1.0'], ['one', '6.2.0'], ['two', '6.3.0']]) {
      const name = parent ? `${parent}/node_modules/@prisma/client` : '@prisma/client'
      const packageDir = createPackage(ambiguousProject, name, { main: 'index.js', version })
      write(packageDir, 'index.js', 'module.exports = {}')
      write(packageDir, 'runtime/library.js', 'module.exports = { same: true }\n')
    }

    const ambiguousConfig = await withDatadogTurbopack({}, { projectDir: ambiguousProject })
    const ambiguousPlanPath = findDatadogLoaders(ambiguousConfig)[0].options.manifestPath
    const ambiguousPlan = JSON.parse(fs.readFileSync(ambiguousPlanPath, 'utf8'))

    assert.equal(ambiguousPlan.relativeTargets.length, 0)
  })

  it('rejects unsupported versions and invalid configuration shapes', async () => {
    const oldProject = createProject('15.4.9')
    const invalidVersionProject = createProject('latest')
    const projectDir = createProject()
    const missingNext = createProject()
    const missingCompiler = createProject()
    fs.rmSync(path.join(missingNext, 'node_modules/next'), { force: true, recursive: true })
    fs.rmSync(path.join(missingCompiler, 'node_modules/next/dist/compiled/babel/parser.js'))

    assert.throws(
      () => withDatadogTurbopack({}, { projectDir: oldProject }),
      { name: 'RangeError', message: /requires Next\.js 15\.5 or newer/ }
    )
    assert.throws(
      () => withDatadogTurbopack({}, { projectDir: missingNext }),
      { message: /could not resolve Next\.js/ }
    )
    assert.throws(
      () => withDatadogTurbopack({}, { projectDir: missingCompiler }),
      { message: /does not provide the compiler/ }
    )
    assert.throws(
      () => withDatadogTurbopack({}, { projectDir: invalidVersionProject }),
      { message: /could not parse Next\.js version/ }
    )
    assert.throws(
      () => withDatadogTurbopack({}, /** @type {object} */ (null)),
      { name: 'TypeError', message: /options must be an object/ }
    )
    assert.throws(
      () => withDatadogTurbopack({}, { projectDir: /** @type {string} */ (42) }),
      { name: 'TypeError', message: /options\.projectDir must be a string/ }
    )
    await assert.rejects(
      withDatadogTurbopack(42, { projectDir }),
      { name: 'TypeError', message: /configuration object, promise, or function/ }
    )
    for (const [config, message] of [
      [{ turbopack: null }, /turbopack must be an object/],
      [{ turbopack: [] }, /turbopack must be an object/],
      [{ turbopack: { rules: false } }, /turbopack\.rules must be an object/],
      [{ turbopack: { rules: [] } }, /turbopack\.rules must be an object/],
      [{ turbopack: { conditions: '' } }, /turbopack\.conditions must be an object/],
      [{ turbopack: { conditions: [] } }, /turbopack\.conditions must be an object/],
      [{ turbopack: { resolveAlias: '' } }, /turbopack\.resolveAlias must be an object/],
      [{ turbopack: { resolveAlias: [] } }, /turbopack\.resolveAlias must be an object/],
    ]) {
      await assert.rejects(withDatadogTurbopack(config, { projectDir }), { message })
    }
  })

  it('does not overwrite a user condition in the reserved Next 15 namespace', async () => {
    const projectDir = createProject('15.5.0')
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packageDir, 'index.js', 'module.exports = {}')

    await assert.rejects(withDatadogTurbopack({
      turbopack: {
        conditions: { '#dd-trace/target': { path: '*.custom.js' } },
      },
    }, { projectDir }), { message: /already uses the reserved condition/ })
  })
})
