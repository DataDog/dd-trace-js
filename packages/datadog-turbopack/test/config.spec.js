'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { afterEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const { withDatadogTurbopack } = require('../../../next')
const hooks = require('../../datadog-instrumentations/src/helpers/hooks')
const instrumentations = require('../../datadog-instrumentations/src/helpers/instrumentations')
const {
  applyDatadogTurbopack,
  cleanup,
  createIoredisProject,
  createPackage,
  createProject,
  findDatadogLoaders,
  write,
} = require('./helpers')

describe('withDatadogTurbopack', () => {
  afterEach(() => {
    cleanup()
    sinon.restore()
  })

  it('exports the wrapper to CommonJS and ESM configurations', async () => {
    const namespace = await import(pathToFileURL(require.resolve('../../../next')).href)

    assert.strictEqual(namespace.withDatadogTurbopack, withDatadogTurbopack)
  })

  it('discovers integrations independently of build-process disablement', async () => {
    const { projectDir } = createIoredisProject()
    const previous = process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
    process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'ioredis'

    try {
      const config = await applyDatadogTurbopack({}, { projectDir })
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

    const config = await applyDatadogTurbopack(input, { projectDir })
    const rules = config.turbopack.rules['*.js']
    const targetRule = rules.find(rule => rule.loaders?.[0]?.options?.targetScope === 'direct')
    const importRule = rules.find(rule => rule.condition?.all?.some(condition => condition?.not === 'foreign'))
    const foreignImportRule = rules.find(rule => rule.condition?.all?.includes('foreign'))

    assert.equal(config.marker, true)
    assert.equal(config.turbopack.resolveAlias.existing, './existing.js')
    assert.deepEqual(rules[0], { loaders: ['existing-loader'] })
    assert.deepEqual(config.turbopack.rules['*.cjs'][0], { loaders: ['existing-array-loader'] })
    assert.equal(targetRule.condition.all[0], 'node')
    assert.equal(targetRule.condition.all[1].path.test('/app/node_modules/ai/index.mjs'), true)
    assert.equal(targetRule.condition.all.some(condition => condition?.not === 'foreign'), false)
    assert.equal(importRule.condition.all[0], 'node')
    assert.equal(importRule.condition.all.some(condition => condition?.not === 'foreign'), true)
    assert.equal(importRule.loaders[0].options.rewriteEdges, true)
    assert.equal(importRule.loaders[0].options.targetScope, undefined)
    assert.equal(foreignImportRule.loaders[0].options.rewriteEdges, true)
    assert.equal(targetRule.loaders[0].options.rewriteEdges, true)
    assert.equal(targetRule.loaders[0].options.targetScope, 'direct')
    const contentPattern = importRule.condition.all.find(condition => condition?.content).content
    const foreignContentPattern = foreignImportRule.condition.all.find(condition => condition?.content).content
    assert.equal(contentPattern.test("import /* webpackChunkName: 'ai' */ ('ai')"), true)
    assert.equal(contentPattern.test('const answer = 42'), false)
    assert.equal(foreignContentPattern.test("import('ai')"), true)
    assert.equal(foreignContentPattern.test("import('unrelated')"), false)
  })

  it('uses named conditions and nested built-ins for Next 15', async () => {
    const { projectDir } = createIoredisProject({ nextVersion: '15.5.0' })
    const aiDirectory = createPackage(projectDir, 'ai', { main: 'index.mjs', type: 'module', version: '7.0.0' })
    write(aiDirectory, 'index.mjs', 'export function generateText () {}\n')
    const prismaDirectory = createPackage(projectDir, '@prisma/client', { main: 'index.js', version: '6.1.0' })
    write(prismaDirectory, 'index.js', 'module.exports = {}')
    write(prismaDirectory, 'runtime/library.js', 'module.exports = {}\n')

    const config = await applyDatadogTurbopack({}, { projectDir })
    const name = '#dd-trace/target'
    const rule = config.turbopack.rules[name]
    const loader = rule.node.loaders[0]

    assert.ok(config.turbopack.conditions[name].path instanceof RegExp)
    assert.equal(config.turbopack.conditions[name].path.test('/app/node_modules/ioredis/index.js'), true)
    assert.equal(config.turbopack.conditions[name].path.test('/app/node_modules/ioredis/package.json'), false)
    assert.equal(Object.keys(config.turbopack.conditions).length, 4)
    assert.ok(config.turbopack.conditions['#dd-trace/import'].content instanceof RegExp)
    assert.ok(config.turbopack.conditions['#dd-trace/foreign-import'].content instanceof RegExp)
    assert.ok(config.turbopack.conditions['#dd-trace/relative'].path instanceof RegExp)
    assert.equal(config.turbopack.rules['#dd-trace/import'].node.foreign, false)
    assert.equal(config.turbopack.rules['#dd-trace/import'].node.default.loaders.length, 1)
    assert.equal(config.turbopack.rules['#dd-trace/import'].node.default.loaders[0].options.rewriteEdges, true)
    assert.equal(config.turbopack.rules['#dd-trace/foreign-import'].node.foreign.loaders[0].options.rewriteEdges, true)
    assert.equal(config.turbopack.rules['#dd-trace/relative'].node.foreign, false)
    assert.equal(config.turbopack.rules['#dd-trace/relative'].node.default.loaders[0].options.targetScope, 'relative')
    assert.equal(rule.condition, undefined)
    assert.equal(typeof loader.loader, 'string')
    JSON.stringify(loader.options)

    const repeated = await applyDatadogTurbopack(config, { projectDir })
    assert.equal(findDatadogLoaders(repeated).length, findDatadogLoaders(config).length)
  })

  it('leaves newer Next majors on the modern schema path', async () => {
    const { projectDir } = createIoredisProject({ nextVersion: '17.0.0-canary.1' })

    const config = await applyDatadogTurbopack({}, { projectDir })

    assert.equal([config.turbopack.rules['*.js']].flat().every(rule => rule.condition), true)
    assert.equal(config.turbopack.conditions, undefined)
  })

  it('supports objects, promises, and config functions through one phase-aware contract', async () => {
    const projectDir = createProject()
    const promisedConfig = { promised: true }
    const promised = withDatadogTurbopack(Promise.resolve(promisedConfig), { projectDir })
    const receiver = { calls: 0 }
    const defaultConfig = { defaultConfig: true }
    const wrapped = withDatadogTurbopack(function (phase, context) {
      this.calls++
      assert.equal(phase, 'phase-production-build')
      assert.strictEqual(/** @type {{ defaultConfig: object }} */ (context).defaultConfig, defaultConfig)
      return { functional: true }
    }, { projectDir })
    const wrappedUndefined = withDatadogTurbopack(() => undefined, { projectDir })

    assert.equal(typeof promised, 'function')
    const promiseResult = await promised('phase-production-build')
    const [functionResult, undefinedResult] = await Promise.all([
      wrapped.call(receiver, 'phase-production-build', { defaultConfig }),
      wrappedUndefined(),
    ])

    assert.strictEqual(promiseResult, promisedConfig)
    assert.equal(receiver.calls, 1)
    assert.deepEqual(functionResult, { functional: true })
    assert.deepEqual(undefinedResult, {})
  })

  it('does not plan during the production server phase', async () => {
    const { projectDir } = createIoredisProject()
    const input = { marker: true }
    const wrapped = withDatadogTurbopack(input, { projectDir })

    const config = await wrapped('phase-production-server')

    assert.strictEqual(config, input)
    assert.equal(fs.existsSync(path.join(projectDir, 'node_modules/.cache/dd-trace/turbopack')), false)
  })

  it('uses the current directory when no project option is provided', async () => {
    const projectDir = createProject()
    const previousDirectory = process.cwd()

    try {
      process.chdir(projectDir)
      assert.deepEqual(await applyDatadogTurbopack(), {})
    } finally {
      process.chdir(previousDirectory)
    }
  })

  it('returns the original object when no supported package is installed', async () => {
    const projectDir = createProject()
    const config = { turbopack: { resolveAlias: { value: './value.js' } } }

    assert.strictEqual(await applyDatadogTurbopack(config, { projectDir }), config)
    assert.equal(fs.existsSync(path.join(projectDir, '.next/cache/dd-trace/turbopack')), false)
    assert.equal(fs.existsSync(path.join(projectDir, 'node_modules/.cache/dd-trace/turbopack')), false)
  })

  it('creates one immutable plan under concurrent and repeated composition', async () => {
    const { projectDir } = createIoredisProject()

    const configs = await Promise.all([
      applyDatadogTurbopack({}, { projectDir }),
      applyDatadogTurbopack({}, { projectDir }),
      applyDatadogTurbopack({}, { projectDir }),
      applyDatadogTurbopack({}, { projectDir }),
    ])
    const planPaths = configs.map(config => findDatadogLoaders(config)[0].options.manifestPath)
    const twice = await applyDatadogTurbopack(configs[0], { projectDir })

    assert.equal(new Set(planPaths).size, 1)
    assert.match(planPaths[0], /\/[a-f\d]{64}\.json$/)
    assert.equal(
      path.basename(planPaths[0], '.json'),
      createHash('sha256').update(fs.readFileSync(planPaths[0])).digest('hex')
    )
    assert.equal(
      path.dirname(planPaths[0]),
      path.join(projectDir, 'node_modules/.cache/dd-trace/turbopack')
    )
    assert.equal(fs.existsSync(path.join(projectDir, '.next/cache/dd-trace/turbopack')), false)
    assert.equal(findDatadogLoaders(twice).length, findDatadogLoaders(configs[0]).length)
    assert.equal(fs.readdirSync(path.dirname(planPaths[0])).length, 1)
  })

  it('keeps build artifacts outside the configured Next.js output directory', async () => {
    const { projectDir } = createIoredisProject()

    const config = await applyDatadogTurbopack({ distDir: 'output' }, { projectDir })
    const planPath = findDatadogLoaders(config)[0].options.manifestPath

    assert.equal(
      path.dirname(planPath),
      path.join(projectDir, 'node_modules/.cache/dd-trace/turbopack')
    )
  })

  it('reports one warning for instrumentation discovery and target compilation failures', async () => {
    const { projectDir } = createIoredisProject()
    const aiDirectory = createPackage(projectDir, 'ai', { main: 'index.mjs', type: 'module', version: '7.0.0' })
    write(aiDirectory, 'index.mjs', 'export {')
    const emitWarning = sinon.stub(process, 'emitWarning')
    const hookName = 'test-turbopack-load-failure'
    const skippedHookName = 'test-turbopack-nonfunction-hook'
    hooks[hookName] = () => throwValue(null)
    hooks[skippedHookName] = {}

    try {
      await applyDatadogTurbopack({}, { projectDir })
      await applyDatadogTurbopack({}, { projectDir })
    } finally {
      delete hooks[hookName]
      delete hooks[skippedHookName]
    }

    assert.equal(emitWarning.callCount, 2)
    sinon.assert.calledWithMatch(
      emitWarning,
      sinon.match(/Could not load the test-turbopack-load-failure instrumentation: null/)
    )
    sinon.assert.calledWithMatch(emitWarning, sinon.match(new RegExp(`Could not instrument ${aiDirectory}`)))
  })

  it('keeps CommonJS package classification when optional source parsing fails', async () => {
    const { projectDir, resourcePath: target } = createIoredisProject({
      source: "module.exports = 'export'\n",
    })
    write(projectDir, 'node_modules/next/dist/compiled/babel/parser.js', [
      "exports.parse = () => { throw new Error('unsupported syntax') }",
      '',
    ].join('\n'))

    const config = await applyDatadogTurbopack({}, { projectDir })
    const planPath = findDatadogLoaders(config)[0].options.manifestPath
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))

    assert.equal(plan.targets[fs.realpathSync(target)].esm, false)
  })

  it('plans importable ESM proxies for cyclic star exports', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ai', {
      main: 'index.mjs',
      type: 'module',
      version: '7.0.0',
    })
    const target = write(packageDir, 'index.mjs', [
      'export function generateText () {}',
      "export * from './cycle.mjs'",
      '',
    ].join('\n'))
    const dependency = write(packageDir, 'cycle.mjs', [
      'export function fromCycle () {}',
      "export * from './index.mjs'",
      '',
    ].join('\n'))

    const config = await applyDatadogTurbopack({}, { projectDir })
    const planPath = findDatadogLoaders(config)[0].options.manifestPath
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
    const entry = plan.targets[fs.realpathSync(target).replaceAll('\\', '/')]
    const namespace = await import(pathToFileURL(entry.proxyPath).href)

    assert.equal(entry.dependencies.length, 1)
    assert.equal(entry.dependencies[0].path, fs.realpathSync(dependency).replaceAll('\\', '/'))
    assert.equal(typeof namespace.generateText, 'function')
    assert.equal(typeof namespace.fromCycle, 'function')
  })

  it('contains native resolver process failures through the public wrapper', async () => {
    const { projectDir } = createIoredisProject()
    const emitWarning = sinon.stub(process, 'emitWarning')

    for (const result of [
      { error: new Error('spawn failed') },
      { status: 1, stderr: 'resolver failed' },
    ]) {
      const targets = proxyquire('../src/targets', {
        'node:child_process': { spawnSync: () => result },
      })
      const wrapper = proxyquire('../', { './src/targets': targets })
      const wrapped = wrapper.withDatadogTurbopack({}, { projectDir })

      assert.deepEqual(
        await wrapped('phase-production-build'),
        {}
      )
    }

    assert.equal(emitWarning.callCount, 2)
    sinon.assert.calledWithMatch(emitWarning, sinon.match(/spawn failed/))
    sinon.assert.calledWithMatch(emitWarning, sinon.match(/resolver failed/))
  })

  it('wraps cache-directory creation failures with their build path', async () => {
    const { projectDir } = createIoredisProject()
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    sinon.stub(fsPromises, 'mkdir').rejects(error)

    await assert.rejects(
      applyDatadogTurbopack({}, { projectDir }),
      { message: /Could not create the Datadog Turbopack cache .*permission denied/ }
    )
  })

  it('accepts an artifact completed by a concurrent build-plan writer', async () => {
    const { projectDir } = createIoredisProject()
    const link = fsPromises.link.bind(fsPromises)
    sinon.stub(fsPromises, 'link').callsFake(async (source, target) => {
      await link(source, target)
      throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
    })

    const config = await applyDatadogTurbopack({}, { projectDir })

    assert.ok(config.turbopack.rules['*.js'])
  })

  it('rejects conflicting and failed artifact writes', async () => {
    const { projectDir } = createIoredisProject()
    const link = fsPromises.link.bind(fsPromises)
    sinon.stub(fsPromises, 'link').callsFake(async (source, target) => {
      await link(source, target)
      await fsPromises.writeFile(target, 'conflict')
      throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
    })

    await assert.rejects(
      applyDatadogTurbopack({}, { projectDir }),
      { message: /artifact .* does not match its content address/ }
    )

    sinon.restore()
    const { projectDir: failedProject } = createIoredisProject()
    sinon.stub(fsPromises, 'link').rejects(Object.assign(new Error('link denied'), { code: 'EACCES' }))

    await assert.rejects(applyDatadogTurbopack({}, { projectDir: failedProject }), { message: /link denied/ })
  })

  it('warns when a temporary artifact cannot be removed', async () => {
    const { projectDir } = createIoredisProject()
    const emitWarning = sinon.stub(process, 'emitWarning')
    sinon.stub(fsPromises, 'unlink').rejects(new Error('unlink denied'))

    const config = await applyDatadogTurbopack({}, { projectDir })

    assert.ok(config.turbopack.rules['*.js'])
    sinon.assert.calledWithMatch(
      emitWarning,
      sinon.match(/Could not remove temporary Turbopack artifact .*unlink denied/)
    )
  })

  it('rejects an existing artifact whose content no longer matches its address', async () => {
    const { projectDir } = createIoredisProject()
    const config = await applyDatadogTurbopack({}, { projectDir })
    const planPath = findDatadogLoaders(config)[0].options.manifestPath
    fs.writeFileSync(planPath, 'conflict')

    await assert.rejects(
      applyDatadogTurbopack({}, { projectDir }),
      { message: /artifact .* does not match its content address/ }
    )
  })

  it('discovers nested copies without persisting hook-array positions', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'parent/node_modules/ioredis', {
      main: 'index.js',
      version: '5.0.0',
    })
    const target = write(packageDir, 'index.js', 'module.exports = {}')

    const config = await applyDatadogTurbopack({}, { projectDir })
    const planPath = findDatadogLoaders(config)[0].options.manifestPath
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
    const entry = plan.targets[fs.realpathSync(target).replaceAll('\\', '/')]

    assert.equal(entry.payloads[0].package, 'ioredis')
    assert.equal(Object.hasOwn(entry.payloads[0], 'instrumentationIndexes'), false)
  })

  it('discovers nested dependencies from the inferred Turbopack root', async () => {
    const workspaceDir = createProject()
    const projectDir = path.join(workspaceDir, 'apps/web')
    write(projectDir, 'package.json', '{}')
    write(workspaceDir, 'node_modules/next/dist/lib/find-root.js', [
      `exports.findRootDirAndLockFiles = () => ({ lockFiles: [], rootDir: ${JSON.stringify(workspaceDir)} })`,
      '',
    ].join('\n'))
    const packageDir = createPackage(workspaceDir, 'parent/node_modules/ioredis', {
      main: 'index.js',
      version: '5.0.0',
    })
    const target = write(packageDir, 'index.js', 'module.exports = {}')

    const config = await applyDatadogTurbopack({}, { projectDir })
    const planPath = findDatadogLoaders(config)[0].options.manifestPath
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))

    assert.ok(plan.targets[fs.realpathSync(target).replaceAll('\\', '/')])
    assert.equal(config.turbopack.root, undefined)
  })

  it('discovers app-local dependencies when the inferred Turbopack root is the workspace', async () => {
    const workspaceDir = createProject()
    const projectDir = path.join(workspaceDir, 'apps/web')
    write(projectDir, 'package.json', '{}')
    write(workspaceDir, 'node_modules/next/dist/lib/find-root.js', [
      `exports.findRootDirAndLockFiles = () => ({ lockFiles: [], rootDir: ${JSON.stringify(workspaceDir)} })`,
      '',
    ].join('\n'))
    const packageDir = createPackage(projectDir, 'ioredis', {
      main: 'index.js',
      version: '5.0.0',
    })
    const target = write(packageDir, 'index.js', 'module.exports = {}')

    const config = await applyDatadogTurbopack({}, { projectDir })
    const planPath = findDatadogLoaders(config)[0].options.manifestPath
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))

    assert.ok(plan.targets[fs.realpathSync(target).replaceAll('\\', '/')])
  })

  it('uses outputFileTracingRoot before the configured Turbopack root', async () => {
    const workspaceDir = createProject()
    const projectDir = path.join(workspaceDir, 'apps/web')
    const turbopackRoot = path.join(workspaceDir, 'turbopack-root')
    write(projectDir, 'package.json', '{}')
    write(turbopackRoot, 'package.json', '{}')
    const packageDir = createPackage(workspaceDir, 'parent/node_modules/ioredis', {
      main: 'index.js',
      version: '5.0.0',
    })
    const target = write(packageDir, 'index.js', 'module.exports = {}')

    const config = await applyDatadogTurbopack({
      outputFileTracingRoot: workspaceDir,
      turbopack: { root: turbopackRoot },
    }, { projectDir })
    const planPath = findDatadogLoaders(config)[0].options.manifestPath
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))

    assert.ok(plan.targets[fs.realpathSync(target).replaceAll('\\', '/')])
    assert.equal(config.turbopack.root, turbopackRoot)
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

    const config = await applyDatadogTurbopack({}, { projectDir })

    assert.ok(config.turbopack.rules['*.js'])
  })

  it('uses native import and require conditions without executing package or preload code', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', {
      exports: {
        import: './import.mjs',
        require: './require.cjs',
      },
      version: '5.0.0',
    })
    const marker = path.join(projectDir, 'executed')
    const preload = write(projectDir, 'preload.js', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`)
    const importTarget = write(
      packageDir,
      'import.mjs',
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, ''); export default class Redis {}`
    )
    const requireTarget = write(
      packageDir,
      'require.cjs',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''); module.exports = class Redis {}`
    )
    const previousNodeOptions = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = `--require=${preload}`

    let config
    try {
      config = await applyDatadogTurbopack({}, { projectDir })
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previousNodeOptions
    }

    const planPath = findDatadogLoaders(config)[0].options.manifestPath
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
    assert.ok(plan.targets[fs.realpathSync(importTarget).replaceAll('\\', '/')])
    assert.ok(plan.targets[fs.realpathSync(requireTarget).replaceAll('\\', '/')])
    assert.equal(fs.existsSync(marker), false)
  })

  it('walks past nested package metadata to the owning package', async () => {
    const projectRoot = createProject()
    const packageDir = createPackage(projectRoot, 'ioredis', {
      exports: './dist/index.js',
      type: 'module',
      version: '5.0.0',
    })
    write(packageDir, 'dist/package.json', JSON.stringify({ name: 'ioredis-internal', type: 'module' }))
    const target = write(packageDir, 'dist/index.js', 'export default class Redis {}')
    const projectDir = path.join(projectRoot, 'app')
    write(projectDir, 'package.json', '{}')

    const config = await applyDatadogTurbopack({}, { projectDir })
    const planPath = findDatadogLoaders(config)[0].options.manifestPath
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))

    assert.ok(plan.targets[fs.realpathSync(target).replaceAll('\\', '/')])
  })

  it('discovers linked workspace dependencies outside node_modules', async () => {
    const workspaceDir = createProject()
    const projectDir = path.join(workspaceDir, 'apps/web')
    write(projectDir, 'package.json', '{}')
    const packageDir = path.join(workspaceDir, 'packages/cache-client')
    write(packageDir, 'package.json', JSON.stringify({ main: 'index.js', name: 'ioredis', version: '5.0.0' }))
    const target = write(packageDir, 'index.js', 'module.exports = {}')
    fs.symlinkSync(packageDir, path.join(workspaceDir, 'node_modules/ioredis'), 'dir')

    const config = await applyDatadogTurbopack({}, { projectDir })
    const targetRule = [config.turbopack.rules['*.js']].flat().find(
      rule => rule.loaders?.[0]?.options?.targetScope === 'direct'
    )
    const planPath = findDatadogLoaders(config)[0].options.manifestPath
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))

    assert.ok(plan.targets[fs.realpathSync(target).replaceAll('\\', '/')])
    assert.equal(
      targetRule.condition.all[1].path.test('../../packages/cache-client/index.js'),
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

    const config = await applyDatadogTurbopack({}, { projectDir })
    const planPath = findDatadogLoaders(config)[0].options.manifestPath
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))

    assert.ok(plan.targets[fs.realpathSync(path.join(packageDir, 'index.js')).replaceAll('\\', '/')])
  })

  it('handles package-boundary traversal failures without losing valid targets', async () => {
    const { packageDir, projectDir } = createIoredisProject()
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

    const config = await applyDatadogTurbopack({}, { projectDir })

    assert.ok(config.turbopack.rules['*.js'])
  })

  it('skips invalid package metadata and file patterns', async () => {
    const projectDir = createProject()
    const invalidPackage = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(invalidPackage, 'package.json', '{')

    assert.deepEqual(await applyDatadogTurbopack({}, { projectDir }), {})

    const validProject = createProject()
    const validPackage = createPackage(validProject, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(validPackage, 'index.js', 'module.exports = {}')
    const hook = /** @type {Function|{ fn: Function }} */ (hooks.ioredis)
    const load = typeof hook === 'function' ? hook : hook.fn
    load()
    const entries = instrumentations.ioredis
    entries.push({ filePattern: '[', hook () {}, versions: ['>=5'] })

    try {
      const config = await applyDatadogTurbopack({}, { projectDir: validProject })
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

    const fallbackConfig = await applyDatadogTurbopack({}, { projectDir: fallbackProject })
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
      const config = await applyDatadogTurbopack({}, { projectDir })
      const planPath = findDatadogLoaders(config)[0].options.manifestPath
      const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))

      assert.equal(plan.relativeTargets.length, 2)
      assert.equal(plan.relativeTargets[0].payloads[0].integration, '@prisma/client')
      assert.equal(plan.relativeTargets[0].payloads[0].package, './runtime/library.js')
      assert.equal(Object.hasOwn(plan.relativeTargets[0].payloads[0], 'instrumentationIndexes'), false)
      assert.equal(plan.relativeTargets[1].payloads[0].integration, '@prisma/client')
      assert.equal(plan.relativeTargets[1].payloads[0].package, './runtime/library.js')
      assert.equal(Object.hasOwn(plan.relativeTargets[1].payloads[0], 'instrumentationIndexes'), false)
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

    const ambiguousConfig = await applyDatadogTurbopack({}, { projectDir: ambiguousProject })
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
      () => applyDatadogTurbopack({}, { projectDir: oldProject }),
      { name: 'RangeError', message: /requires Next\.js 15\.5 or newer/ }
    )
    assert.throws(
      () => applyDatadogTurbopack({}, { projectDir: missingNext }),
      { message: /could not resolve Next\.js/ }
    )
    assert.throws(
      () => applyDatadogTurbopack({}, { projectDir: missingCompiler }),
      { message: /does not provide the compiler/ }
    )
    assert.throws(
      () => applyDatadogTurbopack({}, { projectDir: invalidVersionProject }),
      { message: /could not parse Next\.js version/ }
    )
    assert.throws(
      () => applyDatadogTurbopack({}, /** @type {object} */ (null)),
      { name: 'TypeError', message: /options must be an object/ }
    )
    assert.throws(
      () => applyDatadogTurbopack({}, { projectDir: /** @type {string} */ (/** @type {unknown} */ (42)) }),
      { name: 'TypeError', message: /options\.projectDir must be a string/ }
    )
    await assert.rejects(
      applyDatadogTurbopack(42, { projectDir }),
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
      await assert.rejects(applyDatadogTurbopack(config, { projectDir }), { message })
    }
  })

  it('does not overwrite a user condition in the reserved Next 15 namespace', async () => {
    const { projectDir } = createIoredisProject({ nextVersion: '15.5.0' })

    await assert.rejects(applyDatadogTurbopack({
      turbopack: {
        conditions: { '#dd-trace/target': { path: '*.custom.js' } },
      },
    }, { projectDir }), { message: /already uses the reserved condition/ })
  })
})

/**
 * @param {unknown} value
 */
function throwValue (value) {
  throw value
}
