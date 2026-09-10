'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const vm = require('node:vm')
const { afterEach, describe, it } = require('mocha')

const dc = require('dc-polyfill')
const { ESLint } = require('eslint')
const { engines: eslintEngines } = require('eslint/package.json')
const semver = require('semver')
const sinon = require('sinon')

const loader = require('../src/loader')
const {
  applyDatadogTurbopack,
  cleanup,
  createIoredisProject,
  createLinkedAiProject,
  createPackage,
  createProject,
  findDatadogLoaders,
  write,
} = require('./helpers')

const CHANNEL = 'dd-trace:bundler:load'
const lintRuntimeSupported = semver.satisfies(process.version, eslintEngines.node)
const generatedSourceLinters = new Map()

describe('datadog-turbopack loader', () => {
  afterEach(() => {
    cleanup()
    sinon.restore()
  }).timeout(30000)

  it('does not read package metadata for application modules', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/route.js', '')
    const readFileSync = sinon.spy(fs, 'readFileSync')

    await runLoader(appPath, "module.exports = require('not-installed')\n", fixture.importOptions)

    assert.equal(readFileSync.withArgs(path.join(fixture.projectDir, 'package.json')).callCount, 0)
  })

  it('rewrites ESM imports and only unshadowed CommonJS requires', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/route.js', '')
    const source = [
      "import { generateText } from 'ai'",
      "export { streamText } from 'ai'",
      "const dynamic = import('ai')",
      "const attributed = import('ai', { with: { type: 'json' } })",
      "const top = require('ai')",
      "const commonjs = require('ioredis')",
      "const missing = require('not-installed')",
      "const missingTarget = require('ai/not-installed')",
      "function local (require) { return require('ai') }",
      'export { attributed, commonjs, dynamic, local, missing, missingTarget, top }',
      '',
    ].join('\n')

    const { code: result, map } = await runLoaderResult(appPath, source, fixture.importOptions)
    const proxyFile = path.basename(fixture.proxyPath)

    assert.equal(result.split(proxyFile).length - 1, 4)
    assert.match(result, /const top = require\('ai'\)/)
    assert.match(result, /function local\(require\) \{\s*return require\('ai'\)/)
    assert.equal(map.sources[0], appPath)
    assert.equal(
      path.basename(fixture.proxyPath, '.mjs'),
      createHash('sha256').update(fs.readFileSync(fixture.proxyPath)).digest('hex')
    )
    assert.equal(await runLoader(appPath, source, fixture.importOptions), result)
  })

  it('rewrites imports in TypeScript JSX application modules', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/route.tsx', '')
    const source = [
      "import { generateText } from 'ai'",
      'const prompt: string = \'hello\'',
      'export default <div>{prompt}</div>',
      '',
    ].join('\n')

    const result = await runLoader(appPath, source, fixture.importOptions)

    assert.match(result, new RegExp(path.basename(fixture.proxyPath)))
  })

  it('chains an input source map through module-edge rewriting', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/mapped.js', '')
    const source = "import { generateText } from 'ai'\n"
    const sourceMap = {
      file: appPath,
      mappings: 'AAAA',
      names: [],
      sources: ['route.ts'],
      sourcesContent: [source],
      version: 3,
    }

    const result = await runLoaderResult(appPath, source, fixture.importOptions, { sourceMap })

    assert.deepEqual(result.map.sources, ['route.ts'])
    assert.deepEqual(result.map.sourcesContent, [source])
  })

  it('rewrites static template imports and keeps dynamic templates unchanged', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/templates.js', '')
    const source = [
      'const imported = import(`ai`)',
      'const required = require(`ai`)',
      // eslint-disable-next-line no-template-curly-in-string -- This is source for the loader under test.
      'const dynamic = import(`ai/${name}`)',
      'export { dynamic, imported, required }',
      '',
    ].join('\n')

    const result = await runLoader(appPath, source, fixture.importOptions)

    assert.equal(result.split(path.basename(fixture.proxyPath)).length - 1, 1)
    assert.match(result, /require\(`ai`\)/)
    assert.match(result, /import\(`ai\/\$\{name\}`\)/)
  })

  it('rewrites import-expression AST nodes from newer parsers', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/import-expression.js', '')
    const plan = JSON.parse(fs.readFileSync(fixture.importOptions.manifestPath, 'utf8'))
    plan.compiler.parser = write(fixture.projectDir, 'parser.js', [
      `const parser = require(${JSON.stringify(require.resolve('@babel/parser'))})`,
      'exports.parse = function parse (source, options) {',
      "  source = source.replace('__import__', 'import')",
      '  return parser.parse(source, { ...options, createImportExpressions: true })',
      '}',
      '',
    ].join('\n'))
    const options = {
      ...fixture.importOptions,
      manifestPath: writePlan(path.dirname(fixture.importOptions.manifestPath), JSON.stringify(plan)),
    }

    const result = await runLoader(appPath, "/* import */\nconst value = __import__('ai')\n", options)

    assert.match(result, new RegExp(path.basename(fixture.proxyPath)))
  })

  it('leaves type-only module edges untouched', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/types.ts', '')
    const source = [
      "import type { CoreTool } from 'ai'",
      "import { type LanguageModel } from 'ai'",
      "export type { ToolChoice } from 'ai'",
      "export { type ToolChoice } from 'ai'",
      'import Alias = Namespace.Value',
      '',
    ].join('\n')

    assert.equal(await runLoader(appPath, source, fixture.importOptions), source)
  })

  it('leaves Flow type imports untouched', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/types.js', '')
    const source = [
      "import type { CoreTool } from 'ai'",
      "import typeof GenerateText from 'ai'",
      'const count: number = 1',
      'export { count }',
      '',
    ].join('\n')

    assert.equal(await runLoader(appPath, source, fixture.importOptions), source)
  })

  it('does not pass Node.js built-ins to the Turbopack resolver', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/builtins.js', '')
    const requests = []
    const getResolve = () => (_directory, request, callback) => {
      requests.push(request)
      callback(undefined, fixture.targetPath)
    }
    const source = [
      "import fs from 'node:fs'",
      "import path from 'path'",
      "import { generateText } from 'ai'",
      '',
    ].join('\n')

    const result = await runLoader(appPath, source, fixture.importOptions, { getResolve })

    assert.deepEqual(requests, ['ai'])
    assert.match(result, new RegExp(path.basename(fixture.proxyPath)))
  })

  it('does not redirect a generated proxy back to itself', async () => {
    const fixture = await createAiFixture()
    const source = fs.readFileSync(fixture.proxyPath, 'utf8')
    let resolverCalls = 0
    const getResolve = () => () => {
      resolverCalls++
      throw new Error('generated proxies must not be resolved')
    }

    assert.equal(await runLoader(fixture.proxyPath, source, fixture.importOptions, { getResolve }), source)
    assert.equal(resolverCalls, 0)
  })

  it('parses explicit resource management syntax while rewriting imports', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/resource.js', '')
    const source = [
      "import { generateText } from 'ai'",
      'using resource = { [Symbol.dispose] () {} }',
      'export { resource }',
      '',
    ].join('\n')

    const result = await runLoader(appPath, source, fixture.importOptions)

    assert.match(result, new RegExp(path.basename(fixture.proxyPath)))
  })

  it('parses TypeScript auto-accessors while rewriting imports', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/state.ts', '')
    const source = [
      "import { generateText } from 'ai'",
      'export class State { accessor value = generateText }',
      '',
    ].join('\n')

    const result = await runLoader(appPath, source, fixture.importOptions)

    assert.match(result, new RegExp(path.basename(fixture.proxyPath)))
  })

  it('does not rewrite a require that is shadowed in its own scope', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/route.js', '')
    const source = "const require = load\nconst value = require('ai')\n"

    assert.equal(await runLoader(appPath, source, fixture.importOptions), source)
  })

  it('rewrites require edges only when the require resolver selects an ESM target', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/require.ts', '')
    const source = "import AI = require('ai')\nconst required = require('ai')\nexport { required }\n"
    const resolvedConditions = []
    const getResolve = options => (_directory, _request, callback) => {
      resolvedConditions.push(options.conditionNames)
      queueMicrotask(() => callback(undefined, fixture.targetPath))
    }

    const result = await runLoader(appPath, source, fixture.importOptions, { getResolve })

    assert.equal(result.split(path.basename(fixture.proxyPath)).length - 1, 2)
    assert.deepEqual(resolvedConditions, [['...', 'node', 'require']])
  })

  it('preserves inherited conditions and leaves an unplanned server target unchanged', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/server.js', '')
    const source = "import { generateText } from 'ai'\n"
    const resolvedConditions = []
    const getResolve = options => (_directory, _request, callback) => {
      resolvedConditions.push(options.conditionNames)
      callback(undefined, options.conditionNames.includes('...') ? fixture.reactServerPath : fixture.targetPath)
    }

    assert.equal(await runLoader(appPath, source, fixture.importOptions, { getResolve }), source)
    assert.deepEqual(resolvedConditions, [['...', 'node', 'import']])
  })

  it('tracks bindings from every supported declaration pattern', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/scopes.js', '')
    const source = [
      "import { generateText } from 'ai'",
      'const named = function named () {}',
      "const assigned = (require = load) => require('ai')",
      "const array = ([require]) => require('ai')",
      "const object = ({ require }) => require('ai')",
      'const { require: objectRequire, ...objectRest } = globalThis',
      "const rest = (...require) => require[0]('ai')",
      "function scoped () { var require = load; return require('ai') }",
      "try { scoped() } catch (require) { require('ai') }",
      'try { scoped() } catch {}',
      'const Named = class Named {}',
      'const Anonymous = class {}',
      'export { Anonymous, Named, array, assigned, named, object, objectRequire, objectRest, rest, scoped }',
      '',
    ].join('\n')

    const result = await runLoader(appPath, source, fixture.importOptions)

    assert.equal(result.split(path.basename(fixture.proxyPath)).length - 1, 1)
    assert.match(result, /return require\('ai'\)/)
  })

  it('preserves configured aliases', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ai', { main: 'index.mjs', type: 'module', version: '7.0.0' })
    write(packageDir, 'index.mjs', 'export function generateText () {}\n')
    const config = await applyDatadogTurbopack({
      turbopack: { resolveAlias: { ai: './replacement.js' } },
    }, { projectDir })
    const options = findDatadogLoaders(config)
      .find(item => item.options.targetScope === 'direct').options
    const appPath = write(projectDir, 'app/route.js', '')
    const source = "import { generateText } from 'ai'\nimport value from 'ai/subpath'\n"
    const replacement = write(projectDir, 'replacement.js', 'export const newExport = true\n')
    const getResolve = () => (_directory, _request, callback) => callback(undefined, replacement)
    const plan = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'))
    const targetPath = fs.realpathSync(path.join(packageDir, 'index.mjs'))

    assert.equal(await runLoader(appPath, source, options, { getResolve }), source)
    assert.equal(plan.targets[targetPath].proxyPath, undefined)
  })

  it('rewrites alias keys that resolve to a planned target', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/aliased.js', '')
    const source = "import { generateText } from 'my-ai'\n"
    const getResolve = () => (_directory, request, callback) => {
      assert.equal(request, 'my-ai')
      callback(undefined, fixture.targetPath)
    }

    const result = await runLoader(appPath, source, fixture.importOptions, { getResolve })

    assert.match(result, new RegExp(path.basename(fixture.proxyPath)))
  })

  it('preserves unsupported resolved request shapes before filesystem access', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/queried.js', '')
    const source = "import { generateText } from 'ai'\n"
    const sourceMap = { mappings: 'AAAA', sources: ['queried.ts'], version: 3 }
    const resolvedRequests = [
      `${fixture.targetPath}?raw`,
      `${fixture.targetPath}?url&x=1`,
      `${fixture.targetPath}?`,
      `${fixture.targetPath}#part`,
      `${fixture.targetPath}?raw#part`,
      `${fixture.targetPath}!loader`,
      `loader!${fixture.targetPath}`,
      `${pathToFileURL(fixture.targetPath).href}?raw`,
      `${pathToFileURL(fixture.targetPath).href}?`,
      `${pathToFileURL(fixture.targetPath).href}#part`,
      `${pathToFileURL(fixture.targetPath).href}#`,
      `${pathToFileURL(fixture.targetPath).href}%2Fchild`,
      './relative.mjs',
      '\0virtual',
      'data:text/javascript,export default true',
      'node:fs',
      'virtual:module',
      'https://example.com/module.mjs',
      'file://[invalid',
      42,
    ]
    if (process.platform !== 'win32') {
      const questionPath = `${fixture.targetPath}?literal`
      const fragmentPath = `${fixture.targetPath}#literal`
      fs.symlinkSync(fixture.targetPath, questionPath)
      fs.symlinkSync(fixture.targetPath, fragmentPath)
      resolvedRequests.push(questionPath, fragmentPath)
    }

    for (const resolved of resolvedRequests) {
      const getResolve = () => (_directory, _request, callback) => callback(undefined, resolved)
      const result = await runLoaderResult(appPath, source, fixture.importOptions, { getResolve, sourceMap })
      assert.equal(result.code, source, String(resolved))
      assert.equal(result.map, sourceMap, String(resolved))
    }
  })

  it('normalizes supported file URLs and encoded path characters without changing their identity', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/urls.js', '')
    const source = "import { generateText } from 'ai'\n"
    const encodedPaths = [`${fixture.targetPath}%3F`, `${fixture.targetPath}%23`]
    for (const encodedPath of encodedPaths) fs.symlinkSync(fixture.targetPath, encodedPath)
    const resolvedRequests = [
      pathToFileURL(fixture.targetPath).href,
      ...encodedPaths,
      ...encodedPaths.map(encodedPath => pathToFileURL(encodedPath).href),
    ]
    if (process.platform !== 'win32') {
      const literalPaths = [`${fixture.targetPath}?literal`, `${fixture.targetPath}#literal`]
      for (const literalPath of literalPaths) fs.symlinkSync(fixture.targetPath, literalPath)
      resolvedRequests.push(...literalPaths.map(literalPath => pathToFileURL(literalPath).href))
    }

    for (const resolved of resolvedRequests) {
      const getResolve = () => (_directory, _request, callback) => callback(undefined, resolved)
      const result = await runLoader(appPath, source, fixture.importOptions, { getResolve })
      assert.match(result, new RegExp(path.basename(fixture.proxyPath)), resolved)
    }
  })

  it('returns transformed ESM dependencies without a CommonJS publication tail', async () => {
    const fixture = await createAiFixture()
    const source = fs.readFileSync(fixture.targetPath, 'utf8')

    const result = await runLoader(fixture.targetPath, source, fixture.packageOptions)

    assert.doesNotMatch(result, /dd-trace:bundler:load/)
  })

  it('plans and instruments both sides of a dual package export', async () => {
    const fixture = await createAiFixture()
    const plan = JSON.parse(fs.readFileSync(fixture.packageOptions.manifestPath, 'utf8'))

    assert.ok(plan.targets[fs.realpathSync(fixture.targetPath)])
    assert.ok(plan.targets[fs.realpathSync(fixture.commonJsPath)])
    assert.match(
      await runLoader(fixture.commonJsPath, fs.readFileSync(fixture.commonJsPath, 'utf8'), fixture.packageOptions),
      /dd-trace:bundler:load/
    )
  })

  it('classifies TypeScript module extensions independently of package type', async () => {
    const moduleProject = createProject()
    const moduleDirectory = createPackage(moduleProject, 'ioredis', {
      main: 'index.mts',
      type: 'commonjs',
      version: '5.0.0',
    })
    const moduleSource = 'export const original = true\n'
    const modulePath = write(moduleDirectory, 'index.mts', moduleSource)
    const commonJsProject = createProject()
    const commonJsDirectory = createPackage(commonJsProject, 'ioredis', {
      main: 'index.cts',
      type: 'module',
      version: '5.0.0',
    })
    const commonJsSource = 'module.exports = { original: true }\n'
    const commonJsPath = write(commonJsDirectory, 'index.cts', commonJsSource)
    const [moduleConfig, commonJsConfig] = await Promise.all([
      applyDatadogTurbopack({}, { projectDir: moduleProject }),
      applyDatadogTurbopack({}, { projectDir: commonJsProject }),
    ])
    const moduleOptions = findDatadogLoaders(moduleConfig).find(item => item.options.targetScope === 'direct').options
    const commonJsOptions = findDatadogLoaders(commonJsConfig)
      .find(item => item.options.targetScope === 'direct').options
    const modulePlan = JSON.parse(fs.readFileSync(moduleOptions.manifestPath, 'utf8'))
    const commonJsPlan = JSON.parse(fs.readFileSync(commonJsOptions.manifestPath, 'utf8'))
    const moduleTarget = modulePlan.targets[fs.realpathSync(modulePath)]
    const commonJsTarget = commonJsPlan.targets[fs.realpathSync(commonJsPath)]

    assert.equal(moduleTarget.esm, true)
    assert.equal(typeof moduleTarget.proxyPath, 'string')
    assert.equal(commonJsTarget.esm, false)
    assert.equal(commonJsTarget.proxyPath, undefined)

    const [moduleResult, commonJsResult] = await Promise.all([
      runLoader(modulePath, moduleSource, moduleOptions),
      runLoader(commonJsPath, commonJsSource, commonJsOptions),
    ])

    assert.equal(moduleResult, moduleSource)
    assert.match(commonJsResult, /dd-trace:bundler:load/)
  })

  it('classifies TypeScript ESM syntax independently of package type', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ai', {
      main: 'index.ts',
      type: 'commonjs',
      version: '7.0.0',
    })
    const source = 'export function generateText (input: string): string { return input }\n'
    const resourcePath = write(packageDir, 'index.ts', source)
    const config = await applyDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config).find(item => item.options.targetScope === 'direct').options
    const plan = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'))
    const target = plan.targets[fs.realpathSync(resourcePath)]

    assert.equal(target.esm, true)
    assert.equal(typeof target.proxyPath, 'string')
    assert.doesNotMatch(await runLoader(resourcePath, source, options), /dd-trace:bundler:load/)
  })

  it('rewrites a foreign relative barrel edge through its package-root rule', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'hono', {
      exports: './dist/index.js',
      type: 'module',
      version: '4.12.19',
    })
    const source = "export { Hono } from './hono.js'\n"
    const entryPath = write(packageDir, 'dist/index.js', source)
    const targetPath = write(packageDir, 'dist/hono.js', 'export class Hono {}\n')
    const config = await applyDatadogTurbopack({}, { projectDir })
    const rule = config.turbopack.rules['*.js'].find(rule =>
      rule.condition.all.includes('foreign') &&
      rule.condition.all.some(condition => condition?.path?.test(entryPath)) &&
      rule.condition.all.some(condition => condition?.content?.test(source)))
    assert.ok(rule)
    const options = rule.loaders[0].options
    const plan = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'))
    const proxyPath = plan.targets[fs.realpathSync(targetPath)].proxyPath

    const rewritten = await runLoader(entryPath, source, options)

    assert.match(rewritten, new RegExp(path.basename(proxyPath)))
    assert.doesNotMatch(rewritten, /dd-trace:bundler:load/)
  })

  it('rewrites source instrumentation in linked workspace targets', async () => {
    const source = "export function getTracer () { return 'original' }\n"
    const fixture = await createLinkedAiProject({
      exports: './dist/index.mjs',
      type: 'module',
      version: '6.1.0',
    }, { 'dist/index.mjs': source })
    const options = findDatadogLoaders(fixture.config).find(item => item.options.targetScope === 'direct').options

    const transformed = await runLoader(fixture.files['dist/index.mjs'], source, options)

    assert.match(transformed, /tr_ch_apm_tracingChannel/)
  })

  it('emits the same CommonJS and ESM instrumentation when the build process disables it', () => {
    const runner = path.join(__dirname, 'resources/run-loader-with-build-config.js')
    const { disabled, enabled } = JSON.parse(execFileSync(
      process.execPath,
      [runner],
      { encoding: 'utf8' }
    ))

    for (let index = 0; index < 2; index++) {
      assert.match(enabled[index], /tr_ch_apm_tracingChannel/)
      assert.equal(disabled[index], enabled[index])
    }
  })

  it('rejects stale proxies after linked star-export dependencies change', async () => {
    const workspaceDir = createProject()
    const projectDir = path.join(workspaceDir, 'apps/web')
    write(projectDir, 'package.json', '{}')
    const packageDir = path.join(workspaceDir, 'packages/ai')
    write(packageDir, 'package.json', JSON.stringify({
      exports: './dist/index.mjs',
      name: 'ai',
      type: 'module',
      version: '6.1.0',
    }))
    write(packageDir, 'dist/index.mjs', "export * from './state.mjs'\n")
    const childPath = write(packageDir, 'dist/state.mjs', 'export const state = true\n')
    fs.symlinkSync(packageDir, path.join(workspaceDir, 'node_modules/ai'), 'dir')
    const readFileSync = fs.readFileSync.bind(fs)
    let replaced = false
    sinon.stub(fs, 'readFileSync').callsFake((file, ...args) => {
      const result = readFileSync(file, ...args)
      if (!replaced && file === childPath) {
        replaced = true
        fs.writeFileSync(childPath, 'export const changed = true\n')
      }
      return result
    })
    const config = await applyDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config).find(item => item.options.rewriteEdges && !item.options.targetScope)
      .options
    const resourcePath = write(projectDir, 'route.mjs', '')
    const source = "import { state } from 'ai'\n"
    const warnings = []

    const transformed = await runLoader(resourcePath, source, options, {
      emitWarning: warning => warnings.push(warning),
    })

    assert.equal(transformed, source)
    assert.equal(replaced, true)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].message, /state\.mjs/)
  })

  it('revalidates a cycle plan in a later compilation', async () => {
    const cycleSource = "import './index.mjs'\nexport const value = true\n"
    const fixture = await createLinkedAiProject({
      exports: './dist/index.mjs',
      type: 'module',
      version: '6.1.0',
    }, {
      'dist/cycle.mjs': cycleSource,
      'dist/index.mjs': "import './cycle.mjs'\nexport function generateText () {}\n",
    })
    const options = findDatadogLoaders(fixture.config)
      .find(item => item.options.rewriteEdges && !item.options.targetScope).options
    const plan = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'))
    const targetPath = fs.realpathSync(fixture.files['dist/index.mjs'])
    const cyclePath = fs.realpathSync(fixture.files['dist/cycle.mjs'])
    const source = "import { generateText } from 'ai'\n"
    const resourcePath = write(fixture.projectDir, 'route.mjs', source)
    const warnings = []
    const initial = await runLoader(resourcePath, source, options)
    fs.rmSync(cyclePath)

    const changed = await runLoader(resourcePath, source, options, {
      emitWarning: warning => warnings.push(warning),
    })
    fs.writeFileSync(cyclePath, cycleSource)
    const restored = await runLoader(resourcePath, source, options)

    assert.equal(plan.targets[targetPath].dependencies.length, 0)
    assert.ok(plan.graphDependencies.some(dependency => dependency.path === cyclePath))
    assert.match(initial, new RegExp(path.basename(plan.targets[targetPath].proxyPath)))
    assert.equal(changed, source)
    assert.match(restored, new RegExp(path.basename(plan.targets[targetPath].proxyPath)))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].message, /cycle\.mjs/)
  })

  it('validates each build-context graph once and resets validation for a replacement plan', async () => {
    const cycleSource = "import './index.mjs'\nexport const value = true\n"
    const fixture = await createLinkedAiProject({
      exports: './dist/index.mjs',
      type: 'module',
      version: '6.1.0',
    }, {
      'dist/cycle.mjs': cycleSource,
      'dist/index.mjs': "import './cycle.mjs'\nexport function generateText () {}\n",
    })
    const options = findDatadogLoaders(fixture.config)
      .find(item => item.options.rewriteEdges && !item.options.targetScope).options
    const cyclePath = fs.realpathSync(fixture.files['dist/cycle.mjs'])
    const source = "import { generateText } from 'ai'\n"
    const firstPath = write(fixture.projectDir, 'first.mjs', source)
    const secondPath = write(fixture.projectDir, 'second.mjs', source)
    fs.rmSync(cyclePath)
    const existsSync = sinon.spy(fs, 'existsSync')
    const statSync = sinon.spy(fs, 'statSync')

    assert.equal(await runLoader(firstPath, source, options), source)
    const filesystemChecks = existsSync.callCount + statSync.callCount
    assert.equal(await runLoader(secondPath, source, options), source)
    assert.equal(existsSync.callCount + statSync.callCount, filesystemChecks)
    assert.equal(statSync.withArgs(cyclePath).callCount, 1)

    fs.writeFileSync(cyclePath, cycleSource)
    fs.appendFileSync(fixture.files['dist/index.mjs'], '\n')
    const replacementConfig = await applyDatadogTurbopack({}, { projectDir: fixture.projectDir })
    const replacementOptions = findDatadogLoaders(replacementConfig)
      .find(item => item.options.rewriteEdges && !item.options.targetScope).options
    const replaced = await runLoader(firstPath, source, replacementOptions)

    assert.notEqual(replacementOptions.manifestPath, options.manifestPath)
    assert.match(replaced, /[a-f\d]{64}\.mjs/)
  })

  it('does not instrument a direct target through the relative-copy rule', async () => {
    const fixture = await createAiFixture()
    const source = fs.readFileSync(fixture.ioredisPath, 'utf8')

    const result = await runLoader(fixture.ioredisPath, source, {
      ...fixture.packageOptions,
      targetScope: 'relative',
    })

    assert.equal(result, source)
  })

  it('leaves an unplanned direct module unchanged', async () => {
    const fixture = await createAiFixture()
    const resourcePath = write(fixture.projectDir, 'app/unplanned.js', 'module.exports = true\n')
    const source = fs.readFileSync(resourcePath, 'utf8')

    assert.equal(await runLoader(resourcePath, source, fixture.packageOptions), source)
  })

  it('rejects import parsing failures', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/broken.js', '')

    await assert.rejects(
      runLoader(appPath, 'import {', fixture.importOptions),
      { name: 'SyntaxError' }
    )
  })

  it('rejects parsing failures for matched ESM targets', async () => {
    const fixture = await createAiFixture()

    await assert.rejects(
      runLoader(fixture.targetPath, 'import {', fixture.packageOptions),
      { name: 'SyntaxError' }
    )
  })

  it('accepts CommonJS wrapper returns with legacy parser options', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/optional.js', '')
    const plan = JSON.parse(fs.readFileSync(fixture.importOptions.manifestPath, 'utf8'))
    plan.compiler.parser = write(fixture.projectDir, 'legacy-parser.js', [
      `const parser = require(${JSON.stringify(require.resolve('@babel/parser'))})`,
      'exports.parse = function parse (source, options) {',
      "  if (options.sourceType === 'commonjs') throw new Error('unsupported source type')",
      "  if (options.sourceType === 'script' && (!options.allowReturnOutsideFunction ||",
      "    !options.allowNewTargetOutsideFunction)) throw new Error('missing CommonJS parser options')",
      '  return parser.parse(source, options)',
      '}',
      '',
    ].join('\n'))
    const options = {
      ...fixture.importOptions,
      manifestPath: writePlan(path.dirname(fixture.importOptions.manifestPath), JSON.stringify(plan)),
    }
    const source = [
      "try { require('ai') } catch {}",
      'if (process.env.DD_SKIP_OPTIONAL_MODULE) return',
      '',
    ].join('\n')

    assert.equal(await runLoader(appPath, source, options), source)
  })

  it('rejects CommonJS wrapper returns in ESM files', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/invalid.mjs', '')
    const source = "import 'ai'\nreturn\n"

    await assert.rejects(
      runLoader(appPath, source, fixture.importOptions),
      { name: 'SyntaxError' }
    )
  })

  it('falls back to process warnings when the loader context cannot emit one', async () => {
    const { packageDir, projectDir } = createIoredisProject()
    const resourcePath = write(packageDir, 'index.js', 'module.exports = { first: true }\n')
    const config = await applyDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config)[0].options
    const emitWarning = sinon.stub(process, 'emitWarning')
    const source = 'module.exports = { other: true }\n'
    fs.writeFileSync(resourcePath, source)

    assert.equal(await runLoader(resourcePath, source, options), source)
    sinon.assert.calledOnce(emitWarning)
  })

  it('bounds unique loader warnings at 128', () => {
    const runner = path.join(__dirname, 'resources/check-loader-warning-boundary.js')

    execFileSync(process.execPath, [runner])
  })

  it('rejects when the Turbopack resolver cannot be initialized', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/resolver.js', '')
    const source = "import { generateText } from 'ai'\n"

    await assert.rejects(
      runLoader(appPath, source, fixture.importOptions, {
        getResolve: () => throwValue(new Error('resolver initialization failed')),
      }),
      { message: 'resolver initialization failed' }
    )
  })

  it('leaves failed and undefined optional module resolutions unchanged', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/resolver-edge.js', '')
    const relativeTarget = path.relative(path.dirname(appPath), fixture.targetPath).replaceAll('\\', '/')
    const source = [
      "try { require('ai') } catch {}",
      `import(${JSON.stringify(relativeTarget)}).catch(() => {})`,
      '',
    ].join('\n')
    const requests = []

    const result = await runLoader(appPath, source, fixture.importOptions, {
      getResolve: () => (_directory, request, callback) => {
        requests.push(request)
        if (request === 'ai') callback(new Error('resolution failed'))
        else callback(undefined, undefined)
      },
    })

    assert.equal(result, source)
    assert.deepEqual(requests.sort(), [relativeTarget, 'ai'].sort())
  })

  it('does not scan graph dependencies for edges without a planned proxy', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/unplanned-edge.js', '')
    const unplannedPath = write(fixture.projectDir, 'app/unplanned-target.js', 'export const value = true\n')
    const plan = JSON.parse(fs.readFileSync(fixture.importOptions.manifestPath, 'utf8'))
    const statSync = sinon.spy(fs, 'statSync')
    const source = "import { value } from './unplanned-target.js'\n"

    const result = await runLoader(appPath, source, fixture.importOptions, {
      getResolve: () => (_directory, _request, callback) => callback(undefined, unplannedPath),
    })

    assert.equal(result, source)
    for (const dependency of plan.graphDependencies) {
      assert.equal(statSync.withArgs(dependency.path).callCount, 0)
    }
  })

  it('rejects invalid successful resolver paths', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/resolver-edge.js', '')
    const source = "import { generateText } from 'ai'\n"

    await assert.rejects(
      runLoader(appPath, source, fixture.importOptions, {
        getResolve: () => (_directory, _request, callback) => {
          callback(undefined, path.join(fixture.projectDir, 'missing.js'))
        },
      }),
      { code: 'ENOENT' }
    )
  })

  it('rejects when import generation fails', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/generator.js', '')
    const plan = JSON.parse(fs.readFileSync(fixture.importOptions.manifestPath, 'utf8'))
    plan.compiler.generator = write(
      fixture.projectDir,
      'generator.js',
      "module.exports.default = () => { throw new Error('generation failed') }\n"
    )
    const options = {
      ...fixture.importOptions,
      manifestPath: writePlan(path.dirname(fixture.importOptions.manifestPath), JSON.stringify(plan)),
    }
    const source = "import { generateText } from 'ai'\n"

    await assert.rejects(
      runLoader(appPath, source, options),
      { message: 'generation failed' }
    )
  })

  it('does not redirect an edge after its planned target changes', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/changed-target.js', '')
    const source = "import { generateText } from 'ai'\n"
    const warnings = []
    fs.writeFileSync(fixture.targetPath, 'export function generateText () { return 1 }\n')

    const result = await runLoader(appPath, source, fixture.importOptions, {
      emitWarning: warning => warnings.push(warning),
    })

    assert.equal(result, source)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].message, /Skipped changed dependency/)
  })

  it('publishes CommonJS targets only after fallthrough and with subscribers', async function () {
    this.timeout(30000)
    const source = [
      "'use strict'",
      "require('node:fs')",
      'function local (require, module) { return [require, module] }',
      'function localArgs () { return arguments[0] }',
      'local(() => {}, {})',
      'localArgs(true)',
      "function nested () { return 'nested' }",
      'try {',
      '  module.exports = { original: nested() }',
      '  if (globalThis.DD_TEST_EXIT_EARLY) {',
      '    module.exports.returned = true',
      '    return',
      '  }',
      '} finally {',
      '  module.exports.finalized = true',
      '}',
      '',
    ].join('\n')
    const { projectDir, resourcePath } = createIoredisProject({
      source,
    })
    const config = await applyDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config).find(item => item.options.targetScope === 'direct').options
    const transformed = await runLoader(resourcePath, fs.readFileSync(resourcePath, 'utf8'), options)
    await assertGeneratedSourceIsLintClean(transformed, resourcePath)
    if (lintRuntimeSupported) {
      await assert.rejects(
        assertGeneratedSourceIsLintClean(
          "'use strict'\nrequire('./missing-generated-dependency')\n",
          resourcePath
        ),
        error => error.actual?.some(message => message.ruleId === 'n/no-missing-require')
      )
    }
    const publications = []
    const channel = {
      hasSubscribers: false,
      publish: payload => { publications.push(payload) },
    }

    const inactive = executeCommonJs(transformed, channel)
    channel.hasSubscribers = true
    channel.publish = payload => {
      publications.push(payload)
      payload.module = { patched: true }
    }
    const active = executeCommonJs(transformed, channel)
    const returned = executeCommonJs(transformed, channel, true)

    assert.equal(inactive.original, 'nested')
    assert.equal(inactive.finalized, true)
    assert.equal(inactive.patched, undefined)
    assert.equal(active.patched, true)
    assert.equal(returned.original, 'nested')
    assert.equal(returned.returned, true)
    assert.equal(returned.finalized, true)
    assert.equal(returned.patched, undefined)
    assert.equal(publications.length, 1)
    assert.equal(publications[0].package, 'ioredis')
    assert.equal(publications[0].moduleName, 'ioredis')
    assert.equal(Object.hasOwn(publications[0], 'instrumentationIndexes'), false)
  })

  it('publishes sloppy CommonJS targets with locally bound arguments', async () => {
    const source = 'const local = arguments => arguments[0]\nmodule.exports = { value: local([true]) }\n'
    const { projectDir, resourcePath } = createIoredisProject({ source })
    const config = await applyDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config).find(item => item.options.targetScope === 'direct').options
    const transformed = await runLoader(resourcePath, source, options)
    const channel = {
      hasSubscribers: true,
      publish: payload => { payload.module = { patched: true } },
    }

    assert.equal(executeCommonJs(transformed, channel).patched, true)
  })

  it('fails open for shadowed or mutated CommonJS wrapper bindings', async () => {
    const sources = [
      'function require () { return true }\nmodule.exports = { value: require() }\n',
      'module.exports = { before: typeof require }\nvar require = () => false\n',
      'const original = module\nrequire = () => false\noriginal.exports = { value: true }\n',
      '({ require } = { require: () => false })\nmodule.exports = { value: true }\n',
      'for (require of [() => false]) {}\nmodule.exports = { value: true }\n',
      'for (require in { value: true }) {}\nmodule.exports = { value: true }\n',
      'require++\nmodule.exports = { value: true }\n',
      "eval('require = () => false')\nmodule.exports = { value: true }\n",
      'arguments[1] = () => false\nmodule.exports = { value: true }\n',
      'const mutate = () => { arguments[1] = () => false }\nmutate()\nmodule.exports = { value: true }\n',
      'const args = arguments\nargs[1] = () => false\nmodule.exports = { value: true }\n',
      'var module = { exports: { value: true } }\n',
    ]

    for (const source of sources) {
      const { projectDir, resourcePath } = createIoredisProject({ source })
      const config = await applyDatadogTurbopack({}, { projectDir })
      const options = findDatadogLoaders(config).find(item => item.options.targetScope === 'direct').options
      const warnings = []
      const sourceMap = { mappings: 'AAAA', sources: ['input.js'], version: 3 }
      const result = await runLoaderResult(resourcePath, source, options, {
        emitWarning: warning => warnings.push(warning),
        sourceMap,
      })

      assert.equal(result.code, source)
      assert.strictEqual(result.map, sourceMap)
      assert.equal(warnings.length, 1)
      assert.match(warnings[0].message, /unsafe wrapper bindings/)
    }
  })

  it('rewrites payloadless Orchestrion targets without CommonJS publication', async () => {
    const projectDir = createProject('16.2.0')
    const packageDir = createPackage(projectDir, '@wdio/runner', {
      exports: './build/index.js',
      type: 'module',
      version: '9.1.0',
    })
    const source = 'export class Runner { async run () { return true } }\n'
    const resourcePath = write(packageDir, 'build/index.js', source)
    const config = await applyDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config).find(item => item.options.targetScope === 'direct').options

    const result = await runLoader(resourcePath, source, options)

    assert.match(result, /orchestrion:@wdio\/runner:Runner_run/)
    assert.doesNotMatch(result, /dd-trace:bundler:load/)
  })

  it('lints generated dependencies from their runtime location', async () => {
    const filePath = path.join(path.dirname(require.resolve('dc-polyfill')), '..', '..', 'generated-output.js')

    await assertGeneratedSourceIsLintClean(
      "'use strict'\nrequire('./node_modules/dc-polyfill/dc-polyfill.js')\n",
      filePath
    )
  })

  it('matches relative runtimes by suffix and source hash', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, '@prisma/client', { main: 'index.js', version: '6.1.0' })
    write(packageDir, 'index.js', 'module.exports = {}')
    const source = 'module.exports = { prisma: true }\n'
    write(packageDir, 'runtime/library.js', source)
    const matching = write(projectDir, 'generated/runtime/library.js', source)
    const unrelated = write(projectDir, 'unrelated/runtime/library.js', 'module.exports = { unrelated: true }\n')
    const otherFile = write(projectDir, 'generated/runtime/other.js', source)
    const config = await applyDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config).find(item => item.options.targetScope === 'relative').options
    const matchingResult = await runLoader(matching, source, options)
    const unrelatedSource = fs.readFileSync(unrelated, 'utf8')

    assert.match(matchingResult, /dd-trace:bundler:load/)
    assert.match(matchingResult, /integration: "@prisma\/client"/)
    assert.match(matchingResult, /package: "\.\/runtime\/library\.js"/)
    assert.equal(await runLoader(unrelated, unrelatedSource, options), unrelatedSource)
    assert.equal(await runLoader(otherFile, source, options), source)
  })

  it('evicts old file hashes at the cache boundary', async function () {
    this.timeout(30000)
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, '@prisma/client', { main: 'index.js', version: '6.1.0' })
    write(packageDir, 'index.js', 'module.exports = {}')
    const originalSource = 'module.exports = { first: true }\n'
    const changedSource = 'module.exports = { other: true }\n'
    write(packageDir, 'runtime/library.js', originalSource)
    const config = await applyDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config).find(item => item.options.targetScope === 'relative').options
    const stableTime = new Date('2020-01-01T00:00:00.000Z')
    const files = []

    for (let index = 0; index <= 2048; index++) {
      const file = write(projectDir, `generated/${index}/runtime/library.js`, originalSource)
      fs.utimesSync(file, stableTime, stableTime)
      files.push(file)
      await runLoader(file, originalSource, options)
    }

    const firstStat = fs.statSync(files[0])
    fs.writeFileSync(files[0], changedSource)
    fs.utimesSync(files[0], stableTime, stableTime)
    const statSync = fs.statSync.bind(fs)
    sinon.stub(fs, 'statSync').callsFake(file => file === files[0] ? firstStat : statSync(file))

    assert.equal(Buffer.byteLength(originalSource), Buffer.byteLength(changedSource))
    assert.equal(await runLoader(files[0], changedSource, options), changedSource)
  })

  it('evicts build-plan rewriters at the cache boundary without changing output', async function () {
    this.timeout(30000)
    const { projectDir, resourcePath } = createIoredisProject()
    const source = fs.readFileSync(resourcePath, 'utf8')
    const config = await applyDatadogTurbopack({}, { projectDir })
    const originalOptions = findDatadogLoaders(config).find(item => item.options.targetScope === 'direct').options
    const plan = JSON.parse(fs.readFileSync(originalOptions.manifestPath, 'utf8'))
    const template = plan.targets[fs.realpathSync(resourcePath)]
    const files = []

    for (let index = 0; index <= 64; index++) {
      const directory = path.join(projectDir, 'copies', ...new Array(index).fill('nested'), 'node_modules/ioredis')
      write(directory, 'package.json', JSON.stringify({ name: 'ioredis', version: '5.0.0' }))
      const file = write(directory, 'index.js', source)
      files.push(file)
      plan.targets[fs.realpathSync(file).replaceAll('\\', '/')] = template
    }

    const options = {
      ...originalOptions,
      manifestPath: writePlan(path.dirname(originalOptions.manifestPath), JSON.stringify(plan)),
    }
    const codeTransformer = require('../../../vendor/dist/@apm-js-collab/code-transformer')
    const create = sinon.spy(codeTransformer, 'create')
    const outputs = []

    for (let index = 0; index < 64; index++) {
      outputs[index] = await runLoader(files[index], source, options)
    }
    assert.equal(create.callCount, 64)

    outputs[64] = await runLoader(files[64], source, options)
    assert.equal(create.callCount, 65)
    assert.equal(await runLoader(files[1], source, options), outputs[1])
    assert.equal(create.callCount, 65)
    assert.equal(await runLoader(files[0], source, options), outputs[0])
    assert.equal(create.callCount, 66)
  })

  it('does not use a plan after a dependency changes', async () => {
    const { packageDir, projectDir } = createIoredisProject()
    const before = 'module.exports = { first: true }\n'
    const resourcePath = write(packageDir, 'index.js', before)
    const config = await applyDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config)[0].options
    const source = 'module.exports = { other: true }\n'
    const warnings = []
    const { atime, mtime } = fs.statSync(resourcePath)
    fs.writeFileSync(resourcePath, source)
    fs.utimesSync(resourcePath, atime, mtime)

    const result = await runLoader(resourcePath, source, options, {
      emitWarning: warning => warnings.push(warning),
    })

    assert.equal(result, source)
    assert.equal(Buffer.byteLength(before), Buffer.byteLength(source))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].message, /Skipped changed dependency/)
  })

  it('rejects a build plan that fails its integrity check', async () => {
    const { projectDir, resourcePath } = createIoredisProject()
    const config = await applyDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config)[0].options
    fs.appendFileSync(options.manifestPath, ' ')

    await assert.rejects(
      runLoader(resourcePath, fs.readFileSync(resourcePath, 'utf8'), options),
      { message: /failed its integrity check/ }
    )
  })

  it('rejects missing loader options and unsupported build plans', async () => {
    await assert.rejects(
      runLoader(__filename, '', {}),
      { name: 'TypeError', message: /requires a build plan path/ }
    )

    const { projectDir, resourcePath } = createIoredisProject()
    const config = await applyDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config)[0].options
    const plan = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'))
    plan.version++
    const serialized = JSON.stringify(plan)
    const unsupportedPlanPath = writePlan(path.dirname(options.manifestPath), serialized)

    await assert.rejects(
      runLoader(resourcePath, fs.readFileSync(resourcePath, 'utf8'), {
        ...options,
        manifestPath: unsupportedPlanPath,
      }),
      { message: /build plan .* is not supported/ }
    )

    plan.version--
    delete plan.relativeTargets
    const missingFieldPlan = JSON.stringify(plan)
    const missingFieldPlanPath = writePlan(path.dirname(options.manifestPath), missingFieldPlan)

    await assert.rejects(
      runLoader(resourcePath, fs.readFileSync(resourcePath, 'utf8'), {
        ...options,
        manifestPath: missingFieldPlanPath,
      }),
      { message: /build plan .* is not supported/ }
    )
  })

  it('replaces the cached build plan when its path changes', async () => {
    const fixtures = []

    for (let index = 0; index < 3; index++) {
      const { projectDir, resourcePath } = createIoredisProject({ source: `module.exports = ${index}` })
      const config = await applyDatadogTurbopack({}, { projectDir })
      const options = findDatadogLoaders(config)[0].options
      await runLoader(resourcePath, fs.readFileSync(resourcePath, 'utf8'), options)
      fixtures.push({ options, resourcePath })
    }

    fs.appendFileSync(fixtures[0].options.manifestPath, ' ')

    await assert.rejects(
      runLoader(
        fixtures[0].resourcePath,
        fs.readFileSync(fixtures[0].resourcePath, 'utf8'),
        fixtures[0].options
      ),
      { message: /failed its integrity check/ }
    )
  })

  it('isolates relative diagnostic channel matchers across build plans', async () => {
    const codeTransformer = require('../../../vendor/dist/@apm-js-collab/code-transformer')
    const create = sinon.spy(codeTransformer, 'create')

    for (let index = 0; index < 3; index++) {
      const { projectDir, resourcePath } = createIoredisProject({ source: `module.exports = ${index}` })
      const config = await applyDatadogTurbopack({}, { projectDir })
      const options = findDatadogLoaders(config).find(item => item.options.targetScope === 'direct').options

      await runLoader(resourcePath, fs.readFileSync(resourcePath, 'utf8'), options)
    }

    assert.equal(create.callCount, 3)
  })

  it('keeps each in-flight loader call bound to its build context', async () => {
    const fixtures = []

    for (const name of ['first', 'second']) {
      const source = "import './dependency.mjs'\nexport function getTracer () { return 'original' }\n"
      const fixture = await createLinkedAiProject({
        exports: './dist/index.mjs',
        type: 'module',
        version: '6.1.0',
      }, {
        'dist/dependency.mjs': 'export const dependency = true\n',
        'dist/index.mjs': source,
      })
      const originalOptions = findDatadogLoaders(fixture.config)
        .find(item => item.options.targetScope === 'direct').options
      const plan = JSON.parse(fs.readFileSync(originalOptions.manifestPath, 'utf8'))
      plan.dcPolyfill = path.join(fixture.projectDir, `${name}-dc-polyfill.js`)
      fixtures.push({
        options: {
          ...originalOptions,
          manifestPath: writePlan(path.dirname(originalOptions.manifestPath), JSON.stringify(plan)),
        },
        resourcePath: fixture.files['dist/index.mjs'],
        source,
      })
    }

    const [first, second] = fixtures
    const firstResolver = createPlanResolver(first.options)
    let delayed = false
    let release
    let markStarted
    const started = new Promise(resolve => { markStarted = resolve })
    const pending = runLoader(first.resourcePath, first.source, first.options, {
      getResolve: resolveOptions => {
        const resolve = firstResolver(resolveOptions)
        return (directory, request, callback) => {
          if (!delayed) {
            delayed = true
            release = () => resolve(directory, request, callback)
            markStarted()
            return
          }
          resolve(directory, request, callback)
        }
      },
    })

    await started
    const secondOutput = await runLoader(second.resourcePath, second.source, second.options)
    release()
    const firstOutput = await pending

    assert.match(firstOutput, /first-dc-polyfill\.js/)
    assert.doesNotMatch(firstOutput, /second-dc-polyfill\.js/)
    assert.match(secondOutput, /second-dc-polyfill\.js/)
  })

  it('releases replaced build-plan matchers after active loader calls complete', () => {
    const runner = path.join(__dirname, 'resources/check-loader-context-cleanup.js')
    const output = execFileSync(process.execPath, [
      '--expose-gc',
      runner,
    ], { encoding: 'utf8' })

    assert.equal(output, 'released')
  })

  it('uses a relative proxy specifier for a source beside its generated proxy', async () => {
    const fixture = await createAiFixture()
    const appPath = write(path.dirname(fixture.proxyPath), 'route.js', '')
    const result = await runLoader(appPath, "import { generateText } from 'ai'\n", fixture.importOptions)

    assert.match(result, /from ['"]\.\/[a-f\d]{64}\.mjs['"]/)
  })

  it('keeps ESM exports live and applies patches once per proxy evaluation', async () => {
    const fixture = await createAiFixture()
    const channel = dc.channel(CHANNEL)
    const proxySource = fs.readFileSync(fixture.proxyPath, 'utf8')
    assert.equal(fs.existsSync(path.join(fixture.projectDir, 'node_modules/dc-polyfill')), false)
    assert.doesNotMatch(proxySource, /from ['"]dc-polyfill['"]/)
    await assertGeneratedSourceIsLintClean(proxySource, fixture.proxyPath)
    const inactive = await import(`${pathToFileURL(fixture.proxyPath).href}?inactive`)
    assert.equal(inactive.default(), 'original-default')
    assert.equal(inactive.importedOnly(), 'original-named-only')
    assert.equal(inactive.importedNamespace.starState, 'star-initial')
    assert.equal(inactive.importedState, 'star-initial')
    assert.equal(inactive.namedState, 'star-initial')
    assert.equal(inactive.importedText(), 'original-reexport')
    assert.equal(inactive.namedText(), 'original-reexport')
    assert.equal(inactive['local-text'], 'local-text')
    assert.equal(inactive.reexportedText(), 'original-reexport')
    assert.equal(inactive.renamedOnly(), 'original-named-only')
    assert.equal(inactive.state, 'initial')
    assert.equal(inactive.stateNamespace.starState, 'star-initial')
    assert.equal(inactive.stateDefault, 'state-default')
    assert.equal(inactive.starState, 'star-initial')
    inactive.setState('inactive')
    inactive.setDefaultText('inactive-default')
    inactive.setStarState('star-inactive')
    assert.equal(inactive.default(), 'inactive-default')
    assert.equal(inactive.importedState, 'star-inactive')
    assert.equal(inactive.namedState, 'star-inactive')
    assert.equal(inactive.state, 'inactive')
    assert.equal(inactive.starState, 'star-inactive')
    let publications = 0
    const subscriber = payload => {
      if (payload.package !== 'ai') return
      publications++
      payload.apply({
        generateText: () => 'patched',
        importedOnly: () => 'patched-imported-only',
        importedText: () => 'patched-imported',
        namedText: () => 'patched-named',
        reexportedText: () => 'patched-reexport',
        renamedOnly: () => 'patched-renamed-only',
        stateNamespace: { patched: true },
        streamText: () => 'patched-stream',
      }, false)
    }
    channel.subscribe(subscriber)

    try {
      const active = await import(`${pathToFileURL(fixture.proxyPath).href}?active`)
      assert.equal(active.default(), 'inactive-default')
      assert.equal(inactive.generateText(), 'original')
      assert.equal(active.generateText(), 'patched')
      assert.equal(active.importedOnly(), 'patched-imported-only')
      assert.equal(active.importedNamespace.starState, 'star-inactive')
      assert.equal(active.importedState, 'star-inactive')
      assert.equal(active.importedText(), 'patched-imported')
      assert.equal(active.namedState, 'star-inactive')
      assert.equal(active.namedText(), 'patched-named')
      assert.equal(active['local-text'], 'local-text')
      assert.equal(active.reexportedText(), 'patched-reexport')
      assert.equal(active.renamedOnly(), 'patched-renamed-only')
      assert.equal(active.state, 'inactive')
      assert.deepEqual(active.stateNamespace, { patched: true })
      assert.equal(active.stateDefault, 'state-default')
      assert.equal(active.starState, 'star-inactive')
      active.setState('active')
      active.setDefaultText('active-default')
      active.setStarState('star-active')
      assert.equal(active.default(), 'active-default')
      assert.equal(active.importedState, 'star-active')
      assert.equal(active.namedState, 'star-active')
      assert.equal(active.state, 'active')
      assert.equal(active.starState, 'star-active')
      assert.equal(inactive.state, 'active')
      assert.equal(inactive.default(), 'active-default')
      assert.equal(inactive.importedState, 'star-active')
      assert.equal(inactive.namedState, 'star-active')
      assert.equal(inactive.starState, 'star-active')
      assert.equal(publications, 1)
    } finally {
      channel.unsubscribe(subscriber)
    }
  })

  it('preserves native ESM cycle evaluation through generated proxies', async () => {
    const eventKey = 'dd-trace:turbopack-cycle-events'
    const fixture = await createLinkedAiProject({
      exports: './dist/index.mjs',
      type: 'module',
      version: '6.1.0',
    }, {
      'dist/a.mjs': [
        `const events = globalThis[Symbol.for('${eventKey}')]`,
        "events.push('a:start')",
        "import { ExportedClass, constValue, hoisted, letValue, varValue } from './index.mjs'",
        "import { marker } from './index.mjs'",
        "import { fromB } from './b.mjs'",
        'export const fromA = [hoisted(), varValue, fromB]',
        'export function readA () {',
        '  return [ExportedClass.value, constValue, hoisted(), letValue, marker(), varValue]',
        '}',
        "events.push('a:end')",
        '',
      ].join('\n'),
      'dist/b.mjs': [
        `const events = globalThis[Symbol.for('${eventKey}')]`,
        "events.push('b:start')",
        "import { hoisted } from './index.mjs'",
        'await Promise.resolve()',
        "events.push('b:await')",
        'export const fromB = hoisted()',
        "events.push('b:end')",
        '',
      ].join('\n'),
      'dist/index.mjs': [
        `const events = globalThis[Symbol.for('${eventKey}')]`,
        "events.push('index:start')",
        "import SelfDefault, { hoisted as selfHoisted } from './index.mjs'",
        "import { fromA, readA } from './a.mjs'",
        "export { default as reexportedDefault, namedValue } from './named.mjs'",
        "export * from './star.mjs'",
        "export default class DefaultExport { static value = 'default' }",
        "export class ExportedClass { static value = 'class' }",
        "export var varValue = 'var'",
        "export let letValue = 'let'",
        "export const constValue = 'const'",
        "export function generateText () { return 'generate' }",
        "export function getTracer () { return 'tracer' }",
        "export function hoisted () { return 'hoisted' }",
        "export function marker () { return 'original-marker' }",
        'export function mutate (value) { letValue = value }',
        'export function resolveLanguageModel (value) { return value }',
        'export function selectTelemetryAttributes (value) { return value }',
        'export function snapshot () {',
        '  return {',
        '    a: readA(),',
        '    declarations: [ExportedClass.value, constValue, letValue, varValue],',
        '    fromA,',
        '    self: [SelfDefault.value, selfHoisted()],',
        '  }',
        '}',
        'await Promise.resolve()',
        "events.push('index:end')",
        '',
      ].join('\n'),
      'dist/named.mjs': [
        `const events = globalThis[Symbol.for('${eventKey}')]`,
        "events.push('named:start')",
        "import { hoisted } from './index.mjs'",
        "export default function namedDefault () { return 'named-default' }",
        'export const namedValue = hoisted()',
        "events.push('named:end')",
        '',
      ].join('\n'),
      'dist/star.mjs': [
        `const events = globalThis[Symbol.for('${eventKey}')]`,
        "events.push('star:start')",
        "import { hoisted } from './index.mjs'",
        'export const starValue = hoisted()',
        "events.push('star:end')",
        '',
      ].join('\n'),
    })
    const importerA = write(fixture.projectDir, 'importer-a.mjs', [
      "import DefaultExport, { marker, mutate, snapshot } from 'ai'",
      'export { mutate }',
      'export function readA () {',
      '  return { defaultValue: DefaultExport.value, marker: marker(), snapshot: snapshot() }',
      '}',
      '',
    ].join('\n'))
    const importerB = write(fixture.projectDir, 'importer-b.mjs', [
      "import * as namespace from 'ai'",
      'export function readB () {',
      '  return {',
      '    live: namespace.letValue,',
      '    marker: namespace.marker(),',
      '    named: namespace.namedValue,',
      '    reexported: namespace.reexportedDefault(),',
      '    star: namespace.starValue,',
      '  }',
      '}',
      '',
    ].join('\n'))
    const applicationPath = write(fixture.projectDir, 'application.mjs', [
      "import { mutate, readA } from './importer-a.mjs'",
      "import { readB } from './importer-b.mjs'",
      'export async function read () {',
      "  const dynamic = await import('ai')",
      '  const before = { a: readA(), b: readB(), dynamic: dynamic.marker() }',
      "  mutate('changed')",
      '  return {',
      '    after: { a: readA(), b: readB(), dynamic: dynamic.marker() },',
      '    before,',
      `    events: globalThis[Symbol.for('${eventKey}')],`,
      '  }',
      '}',
      '',
    ].join('\n'))
    const loaders = findDatadogLoaders(fixture.config)
    const importOptions = loaders.find(item => item.options.rewriteEdges && !item.options.targetScope).options
    const plan = JSON.parse(fs.readFileSync(importOptions.manifestPath, 'utf8'))
    const targetPath = fs.realpathSync(fixture.files['dist/index.mjs'])
    const target = plan.targets[targetPath]
    const expectedPublications = target.payloads.length
    const runner = path.join(__dirname, 'resources/run-esm-cycle-proxy.mjs')
    const run = mode => JSON.parse(execFileSync(process.execPath, [runner, applicationPath, mode], {
      encoding: 'utf8',
    }))
    const native = run('native')
    const sources = new Map([
      ...Object.values(fixture.files).map(file => [file, fs.readFileSync(file, 'utf8')]),
      [importerA, fs.readFileSync(importerA, 'utf8')],
      [importerB, fs.readFileSync(importerB, 'utf8')],
      [applicationPath, fs.readFileSync(applicationPath, 'utf8')],
    ])
    const outputs = new Map()

    for (const [file, source] of sources) {
      outputs.set(file, await runLoader(file, source, importOptions))
    }
    const component = plan.components[targetPath]
    assert.ok(component)
    for (const file of Object.values(fixture.files)) {
      assert.equal(plan.components[fs.realpathSync(file)], component)
      assert.doesNotMatch(outputs.get(file), new RegExp(path.basename(target.proxyPath)))
    }
    assert.match(outputs.get(importerA), new RegExp(path.basename(target.proxyPath)))
    assert.match(outputs.get(importerB), new RegExp(path.basename(target.proxyPath)))
    assert.match(outputs.get(applicationPath), new RegExp(path.basename(target.proxyPath)))
    for (const [file, output] of outputs) fs.writeFileSync(file, output)

    assert.deepEqual(native.value.before, {
      a: {
        defaultValue: 'default',
        marker: 'original-marker',
        snapshot: {
          a: ['class', 'const', 'hoisted', 'let', 'original-marker', 'var'],
          declarations: ['class', 'const', 'let', 'var'],
          fromA: ['hoisted', null, 'hoisted'],
          self: ['default', 'hoisted'],
        },
      },
      b: {
        live: 'let',
        marker: 'original-marker',
        named: 'hoisted',
        reexported: 'named-default',
        star: 'hoisted',
      },
      dynamic: 'original-marker',
    })
    assert.deepEqual(native.value.events, [
      'b:start',
      'named:start',
      'named:end',
      'star:start',
      'star:end',
      'b:await',
      'b:end',
      'a:start',
      'a:end',
      'index:start',
      'index:end',
    ])
    assert.equal(native.value.after.a.snapshot.a[3], 'changed')
    assert.equal(native.value.after.a.snapshot.declarations[2], 'changed')
    assert.equal(native.value.after.b.live, 'changed')
    assert.deepEqual(run('inactive'), native)
    assert.deepEqual(run('disabled'), native)

    const named = run('named')
    assert.equal(named.publications, expectedPublications)
    assert.equal(named.value.before.a.marker, 'patched-marker')
    assert.equal(named.value.before.b.marker, 'patched-marker')
    assert.equal(named.value.before.dynamic, 'patched-marker')
    assert.deepEqual(named.value.before.a.snapshot, native.value.before.a.snapshot)

    const patchedDefault = run('default')
    assert.equal(patchedDefault.publications, expectedPublications)
    assert.equal(patchedDefault.value.before.a.defaultValue, 'patched-default')
    assert.deepEqual(patchedDefault.value.before.a.snapshot, native.value.before.a.snapshot)
  })
})

/**
 * @param {string} [ioredisSource]
 * @returns {Promise<{
 *   commonJsPath: string,
 *   importOptions: object,
 *   ioredisPath: string,
 *   packageOptions: object,
 *   projectDir: string,
 *   proxyPath: string,
 *   reactServerPath: string,
 *   targetPath: string
 * }>}
 */
async function createAiFixture (ioredisSource = 'module.exports = {}') {
  const projectDir = createProject()
  const packageDir = createPackage(projectDir, 'ai', {
    exports: {
      'react-server': './react-server.mjs',
      import: './index.mjs',
      require: './index.cjs',
    },
    main: 'index.cjs',
    type: 'module',
    version: '7.0.0',
  })
  write(packageDir, 'index.mjs', [
    "import stateDefault, * as importedNamespace from './state.mjs'",
    "import { reexportedText as importedText, starState as importedState } from './state.mjs'",
    "import { namedOnly as importedOnly } from './named-only.mjs'",
    "const localText = 'local-text'",
    "export { importedNamespace, importedOnly, importedState, importedText, localText as 'local-text', stateDefault }",
    "export { namedOnly as renamedOnly } from './named-only.mjs'",
    "export { reexportedText as namedText, starState as namedState } from './state.mjs'",
    "export * as stateNamespace from './state.mjs'",
    "export default function defaultText () { return 'original-default' }",
    "export function generateText () { return 'original' }",
    'export function setDefaultText (value) { defaultText = () => value }',
    "export function streamText () { return 'original-stream' }",
    "export let state = 'initial'",
    'export function setState (value) { state = value }',
    "export * from './state.mjs'",
    "export * from './other.mjs'",
    '',
  ].join('\n'))
  write(packageDir, 'state.mjs', [
    "export default 'state-default'",
    "export function reexportedText () { return 'original-reexport' }",
    "export let starState = 'star-initial'",
    'export function setStarState (value) { starState = value }',
    '',
  ].join('\n'))
  write(packageDir, 'other.mjs', 'export const other = true\n')
  write(packageDir, 'named-only.mjs', "export function namedOnly () { return 'original-named-only' }\n")
  const reactServerPath = write(packageDir, 'react-server.mjs', 'export function generateText () {}\n')
  const commonJsPath = write(packageDir, 'index.cjs', 'module.exports = {}\n')
  const ioredisDirectory = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
  const ioredisPath = write(ioredisDirectory, 'index.js', ioredisSource)
  const config = await applyDatadogTurbopack({}, { projectDir })
  const loaders = findDatadogLoaders(config)
  const importOptions = loaders.find(item => item.options.rewriteEdges && !item.options.targetScope).options
  const packageOptions = loaders.find(item => item.options.targetScope === 'direct').options
  const plan = JSON.parse(fs.readFileSync(importOptions.manifestPath, 'utf8'))
  const targetEntry = Object.entries(plan.targets).find(([, entry]) => entry.esm)
  assert.ok(targetEntry)
  const [targetPath, target] = targetEntry

  return {
    commonJsPath,
    importOptions,
    ioredisPath,
    packageOptions,
    projectDir,
    proxyPath: target.proxyPath,
    reactServerPath,
    targetPath,
  }
}

/**
 * @param {string} resourcePath
 * @param {string} source
 * @param {object} options
 * @param {{ emitWarning?: (warning: Error) => void, getResolve?: Function }} [settings]
 * @returns {Promise<string>}
 */
async function runLoader (resourcePath, source, options, settings = {}) {
  const { code } = await runLoaderResult(resourcePath, source, options, settings)
  return code
}

/**
 * @param {string} directory
 * @param {string} serialized
 * @returns {string}
 */
function writePlan (directory, serialized) {
  const manifestHash = createHash('sha256').update(serialized).digest('hex')
  return write(directory, `${manifestHash}.json`, serialized)
}

/**
 * @param {string} resourcePath
 * @param {string} source
 * @param {object} options
 * @param {{ emitWarning?: (warning: Error) => void, getResolve?: Function, sourceMap?: object }} [settings]
 * @returns {Promise<{ code: string, map?: object }>}
 */
function runLoaderResult (resourcePath, source, options, settings = {}) {
  return new Promise((resolve, reject) => {
    /**
     * @param {Error} [error]
     * @param {string} [code]
     * @param {object} [map]
     */
    function callback (error, code, map) {
      if (error) reject(error)
      else resolve({ code: /** @type {string} */ (code), map })
    }

    loader.call({
      async: () => callback,
      emitWarning: settings.emitWarning,
      getOptions: () => options,
      getResolve: settings.getResolve ?? createPlanResolver(options),
      resourcePath,
    }, source, settings.sourceMap)
  })
}

/**
 * Resolves unit-test edges from the build plan. Real Turbopack resolution is
 * covered by the integration suite.
 *
 * @param {{ manifestPath: string }} options
 * @returns {(resolveOptions: { conditionNames: string[] }) => Function}
 */
function createPlanResolver (options) {
  let plan

  return resolveOptions => (directory, request, callback) => {
    plan ??= JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'))
    if (request.startsWith('.')) {
      callback(undefined, fs.realpathSync(path.resolve(directory, request)).replaceAll('\\', '/'))
      return
    }

    const candidates = []
    for (const [targetPath, target] of Object.entries(plan.targets)) {
      if (target.payloads.some(payload => payload.path === request)) candidates.push([targetPath, target])
    }

    const expectsEsm = resolveOptions.conditionNames.includes('import')
    const match = candidates.find(([, target]) => target.esm === expectsEsm) ?? candidates[0]
    if (match) {
      callback(undefined, match[0])
    } else {
      callback(new Error(`Could not resolve ${request}`))
    }
  }
}

/**
 * @param {string} source
 * @param {object} channel
 * @param {boolean} [exitEarly]
 * @returns {object}
 */
function executeCommonJs (source, channel, exitEarly = false) {
  const module = { exports: {} }
  const wrapper = vm.runInNewContext(Module.wrap(source), { DD_TEST_EXIT_EARLY: exitEarly })
  wrapper.call(
    module.exports,
    module.exports,
    () => ({ channel: () => channel }),
    module,
    __filename,
    __dirname
  )
  return module.exports
}

/**
 * @param {unknown} value
 */
function throwValue (value) {
  throw value
}

/**
 * @param {string} source
 * @param {string} filePath
 * @returns {Promise<void>}
 */
async function assertGeneratedSourceIsLintClean (source, filePath) {
  if (!lintRuntimeSupported) return

  const root = path.parse(filePath).root
  let linter = generatedSourceLinters.get(root)
  if (!linter) {
    linter = new ESLint({
      cwd: root,
      overrideConfig: [
        { ignores: ['!**/node_modules/', '!**/node_modules/**'] },
        {
          linterOptions: { reportUnusedDisableDirectives: false },
          rules: {
            'n/no-unpublished-import': 'off',
            'n/no-unpublished-require': 'off',
          },
        },
      ],
      overrideConfigFile: path.join(__dirname, '../../../eslint.config.mjs'),
    })
    generatedSourceLinters.set(root, linter)
  }
  const [result] = await linter.lintText(source, { filePath })
  assert.deepEqual(result.messages, [])
}
