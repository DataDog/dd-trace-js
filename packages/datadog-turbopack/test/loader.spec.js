'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const { afterEach, describe, it } = require('mocha')

const dc = require('dc-polyfill')
const enhancedResolve = require('enhanced-resolve')
const { ESLint } = require('eslint')
const { engines: eslintEngines } = require('eslint/package.json')
const semver = require('semver')
const sinon = require('sinon')

const { withDatadogTurbopack } = require('../../../next')
const loader = require('../src/loader')
const {
  cleanup,
  createPackage,
  createProject,
  findDatadogLoaders,
  write,
} = require('./helpers')

const CHANNEL = 'dd-trace:bundler:load'
const lintRuntimeSupported = semver.satisfies(process.version, eslintEngines.node)

afterEach(() => {
  cleanup()
  sinon.restore()
}).timeout(30000)

describe('datadog-turbopack loader', () => {
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
    const parserPath = fixture.importOptions.compiler.parser
    const parser = write(fixture.projectDir, 'parser.js', [
      `const parser = require(${JSON.stringify(parserPath)})`,
      'exports.parse = function parse (source, options) {',
      '  return parser.parse(source, { ...options, createImportExpressions: true })',
      '}',
      '',
    ].join('\n'))
    const options = {
      ...fixture.importOptions,
      compiler: { ...fixture.importOptions.compiler, parser },
    }

    const result = await runLoader(appPath, "const value = import('ai')\n", options)

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
    const getResolve = () => (_directory, _request, callback) => {
      resolverCalls++
      callback(new Error('generated proxies must not be resolved'))
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
    assert.deepEqual(resolvedConditions, [['node', 'require']])
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
    const config = await withDatadogTurbopack({
      turbopack: { resolveAlias: { ai: './replacement.js' } },
    }, { projectDir })
    const options = findDatadogLoaders(config)
      .find(item => item.options.rewriteEdges && !item.options.targetScope).options
    const appPath = write(projectDir, 'app/route.js', '')
    const source = "import { generateText } from 'ai'\nimport value from 'ai/subpath'\n"
    const replacement = write(projectDir, 'replacement.js', 'export default true\n')
    const getResolve = () => (_directory, _request, callback) => callback(undefined, replacement)

    assert.equal(await runLoader(appPath, source, options, { getResolve }), source)
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
      withDatadogTurbopack({}, { projectDir: moduleProject }),
      withDatadogTurbopack({}, { projectDir: commonJsProject }),
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

  it('rewrites a foreign integration edge through the direct-target rule', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'hono', {
      exports: './dist/index.js',
      type: 'module',
      version: '4.12.19',
    })
    const source = "export { Hono } from './hono.js'\n"
    const entryPath = write(packageDir, 'dist/index.js', source)
    const targetPath = write(packageDir, 'dist/hono.js', 'export class Hono {}\n')
    const config = await withDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config).find(item => item.options.targetScope === 'direct').options
    const plan = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'))
    const proxyPath = plan.targets[fs.realpathSync(targetPath)].proxyPath

    const rewritten = await runLoader(entryPath, source, options)

    assert.match(rewritten, new RegExp(path.basename(proxyPath)))
    assert.doesNotMatch(rewritten, /dd-trace:bundler:load/)
  })

  it('rewrites source instrumentation in linked workspace targets', async () => {
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
    const source = "export function getTracer () { return 'original' }\n"
    const targetPath = write(packageDir, 'dist/index.mjs', source)
    fs.symlinkSync(packageDir, path.join(workspaceDir, 'node_modules/ai'), 'dir')
    const config = await withDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config).find(item => item.options.targetScope === 'direct').options

    const transformed = await runLoader(targetPath, source, options)

    assert.match(transformed, /tr_ch_apm_tracingChannel/)
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
    const config = await withDatadogTurbopack({}, { projectDir })
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

  it('does not instrument a direct target through the relative-copy rule', async () => {
    const fixture = await createAiFixture()
    const source = fs.readFileSync(fixture.ioredisPath, 'utf8')

    const result = await runLoader(fixture.ioredisPath, source, {
      ...fixture.packageOptions,
      targetScope: 'relative',
    })

    assert.equal(result, source)
  })

  it('keeps source and emits one warning when import parsing fails', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/broken.js', '')
    const warnings = []
    const source = 'import {'
    assert.equal(await runLoader(appPath, source, fixture.importOptions, {
      emitWarning: warning => warnings.push(warning),
    }), source)
    assert.equal(await runLoader(appPath, source, fixture.importOptions, {
      emitWarning: warning => warnings.push(warning),
    }), source)
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].name, 'DatadogTurbopackWarning')
  })

  it('falls back to process warnings when the loader context cannot emit one', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/process-warning.js', '')
    const emitWarning = sinon.stub(process, 'emitWarning')

    assert.equal(await runLoader(appPath, 'import {', fixture.importOptions), 'import {')
    sinon.assert.calledOnce(emitWarning)
  })

  it('keeps source when the Turbopack resolver cannot be initialized', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/resolver.js', '')
    const source = "import { generateText } from 'ai'\n"
    const warnings = []
    const getResolve = () => throwValue(null)

    const result = await runLoader(appPath, source, fixture.importOptions, {
      emitWarning: warning => warnings.push(warning),
      getResolve,
    })

    assert.equal(result, source)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].message, /Could not initialize import resolution.*null/)
  })

  it('settles each resolver once and contains edge-resolution failures', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/resolver-edge.js', '')
    const source = "import { generateText } from 'ai'\n"
    const duplicateCallback = () => (_directory, _request, callback) => {
      callback(undefined, fixture.targetPath)
      callback(new Error('late failure'))
    }

    const rewritten = await runLoader(appPath, source, fixture.importOptions, {
      getResolve: duplicateCallback,
    })
    assert.match(rewritten, new RegExp(path.basename(fixture.proxyPath)))

    const throwingResolver = () => () => {
      throw new Error('resolution failed')
    }
    assert.equal(await runLoader(appPath, source, fixture.importOptions, {
      getResolve: throwingResolver,
    }), source)

    const missingTarget = () => (_directory, _request, callback) => {
      callback(undefined, path.join(fixture.projectDir, 'missing.js'))
    }
    assert.equal(await runLoader(appPath, source, fixture.importOptions, {
      getResolve: missingTarget,
    }), source)
  })

  it('keeps source when import generation fails', async () => {
    const fixture = await createAiFixture()
    const appPath = write(fixture.projectDir, 'app/generator.js', '')
    const generator = write(
      fixture.projectDir,
      'generator.js',
      "module.exports.default = () => { throw new Error('generation failed') }\n"
    )
    const options = {
      ...fixture.importOptions,
      compiler: { ...fixture.importOptions.compiler, generator },
    }
    const source = "import { generateText } from 'ai'\n"
    const warnings = []

    const result = await runLoader(appPath, source, options, {
      emitWarning: warning => warnings.push(warning),
    })

    assert.equal(result, source)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0].message, /Could not generate rewritten imports/)
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

  it('publishes CommonJS targets only when the channel has subscribers', async function () {
    this.timeout(30000)
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    const resourcePath = write(packageDir, 'index.js', "'use strict'\n\nmodule.exports = { original: true }\n")
    const config = await withDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config).find(item => item.options.targetScope === 'direct').options
    const transformed = await runLoader(resourcePath, fs.readFileSync(resourcePath, 'utf8'), options)
    await assertGeneratedSourceIsLintClean(transformed, 'generated.cjs')
    const publications = []
    const channel = {
      hasSubscribers: false,
      publish: payload => publications.push(payload),
    }

    const inactive = executeCommonJs(transformed, channel)
    channel.hasSubscribers = true
    channel.publish = payload => {
      publications.push(payload)
      payload.module = { patched: true }
    }
    const active = executeCommonJs(transformed, channel)

    assert.equal(inactive.original, true)
    assert.equal(inactive.patched, undefined)
    assert.equal(active.patched, true)
    assert.equal(publications.length, 1)
    assert.equal(publications[0].package, 'ioredis')
    assert.equal(publications[0].moduleName, 'ioredis')
    assert.equal(Object.hasOwn(publications[0], 'instrumentationIndexes'), false)
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
    const config = await withDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config).find(item => item.options.targetScope === 'relative').options
    const matchingResult = await runLoader(matching, source, options)
    const unrelatedSource = fs.readFileSync(unrelated, 'utf8')

    assert.match(matchingResult, /dd-trace:bundler:load/)
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
    const config = await withDatadogTurbopack({}, { projectDir })
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

  it('does not use a plan after a dependency changes', async () => {
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    const before = 'module.exports = { first: true }\n'
    const resourcePath = write(packageDir, 'index.js', before)
    const config = await withDatadogTurbopack({}, { projectDir })
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
    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    const resourcePath = write(packageDir, 'index.js', 'module.exports = {}')
    const config = await withDatadogTurbopack({}, { projectDir })
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
      { name: 'TypeError', message: /requires a build plan path and hash/ }
    )

    const projectDir = createProject()
    const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
    const resourcePath = write(packageDir, 'index.js', 'module.exports = {}')
    const config = await withDatadogTurbopack({}, { projectDir })
    const options = findDatadogLoaders(config)[0].options
    const plan = JSON.parse(fs.readFileSync(options.manifestPath, 'utf8'))
    plan.version++
    const serialized = JSON.stringify(plan)
    fs.writeFileSync(options.manifestPath, serialized)

    await assert.rejects(
      runLoader(resourcePath, fs.readFileSync(resourcePath, 'utf8'), {
        ...options,
        manifestHash: createHash('sha256').update(serialized).digest('hex'),
      }),
      { message: /build plan .* is not supported/ }
    )

    plan.version--
    delete plan.relativeTargets
    const missingFieldPlan = JSON.stringify(plan)
    fs.writeFileSync(options.manifestPath, missingFieldPlan)

    await assert.rejects(
      runLoader(resourcePath, fs.readFileSync(resourcePath, 'utf8'), {
        ...options,
        manifestHash: createHash('sha256').update(missingFieldPlan).digest('hex'),
      }),
      { message: /build plan .* is not supported/ }
    )
  })

  it('evicts old build plans at the cache boundary', async function () {
    this.timeout(30000)
    const fixtures = []

    for (let index = 0; index <= 16; index++) {
      const projectDir = createProject()
      const packageDir = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
      const resourcePath = write(packageDir, 'index.js', `module.exports = ${index}`)
      const config = await withDatadogTurbopack({}, { projectDir })
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

  it('uses a relative proxy specifier for a source beside its generated proxy', async () => {
    const fixture = await createAiFixture()
    const appPath = write(path.dirname(fixture.proxyPath), 'route.js', '')
    const result = await runLoader(appPath, "import { generateText } from 'ai'\n", fixture.importOptions)

    assert.match(result, /from ['"]\.\/[a-f\d]{64}\.mjs['"]/)
  })

  it('keeps ESM exports live and applies patches once per proxy evaluation', async () => {
    const fixture = await createAiFixture()
    const channel = dc.channel(CHANNEL)
    await assertGeneratedSourceIsLintClean(fs.readFileSync(fixture.proxyPath, 'utf8'), 'generated.mjs')
    const inactive = await import(`${pathToFileURL(fixture.proxyPath).href}?inactive`)
    assert.equal(inactive.importedState, 'star-initial')
    assert.equal(inactive.namedState, 'star-initial')
    assert.equal(inactive.state, 'initial')
    assert.equal(inactive.starState, 'star-initial')
    inactive.setState('inactive')
    inactive.setStarState('star-inactive')
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
        streamText: () => 'patched-stream',
      }, false)
    }
    channel.subscribe(subscriber)

    try {
      const active = await import(`${pathToFileURL(fixture.proxyPath).href}?active`)
      assert.equal(inactive.generateText(), 'original')
      assert.equal(active.generateText(), 'patched')
      assert.equal(active.importedState, 'star-inactive')
      assert.equal(active.namedState, 'star-inactive')
      assert.equal(active.state, 'inactive')
      assert.equal(active.starState, 'star-inactive')
      active.setState('active')
      active.setStarState('star-active')
      assert.equal(active.importedState, 'star-active')
      assert.equal(active.namedState, 'star-active')
      assert.equal(active.state, 'active')
      assert.equal(active.starState, 'star-active')
      assert.equal(inactive.state, 'active')
      assert.equal(inactive.importedState, 'star-active')
      assert.equal(inactive.namedState, 'star-active')
      assert.equal(inactive.starState, 'star-active')
      assert.equal(publications, 1)
    } finally {
      channel.unsubscribe(subscriber)
    }
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
 *   targetPath: string
 * }>}
 */
async function createAiFixture (ioredisSource = 'module.exports = {}') {
  const projectDir = createProject()
  const packageDir = createPackage(projectDir, 'ai', {
    exports: {
      import: './index.mjs',
      require: './index.cjs',
    },
    main: 'index.cjs',
    type: 'module',
    version: '7.0.0',
  })
  write(packageDir, 'index.mjs', [
    "import { starState as importedState } from './state.mjs'",
    'export { importedState }',
    "export { starState as namedState } from './state.mjs'",
    "export function generateText () { return 'original' }",
    "export function streamText () { return 'original-stream' }",
    "export let state = 'initial'",
    'export function setState (value) { state = value }',
    "export * from './state.mjs'",
    '',
  ].join('\n'))
  write(packageDir, 'state.mjs', [
    "export let starState = 'star-initial'",
    'export function setStarState (value) { starState = value }',
    '',
  ].join('\n'))
  const commonJsPath = write(packageDir, 'index.cjs', 'module.exports = {}\n')
  const ioredisDirectory = createPackage(projectDir, 'ioredis', { main: 'index.js', version: '5.0.0' })
  const ioredisPath = write(ioredisDirectory, 'index.js', ioredisSource)
  const config = await withDatadogTurbopack({}, { projectDir })
  const loaders = findDatadogLoaders(config)
  const importOptions = loaders.find(item => item.options.rewriteEdges && !item.options.targetScope).options
  const packageOptions = loaders.find(item => item.options.targetScope === 'direct').options
  const plan = JSON.parse(fs.readFileSync(importOptions.manifestPath, 'utf8'))
  const [targetPath, target] = Object.entries(plan.targets).find(([, entry]) => entry.esm)

  return {
    commonJsPath,
    importOptions,
    ioredisPath,
    packageOptions,
    projectDir,
    proxyPath: target.proxyPath,
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
      else resolve({ code, map })
    }

    loader.call({
      async: () => callback,
      emitWarning: settings.emitWarning,
      getOptions: () => options,
      getResolve: settings.getResolve ?? (resolveOptions => enhancedResolve.create(resolveOptions)),
      resourcePath,
    }, source, settings.sourceMap)
  })
}

/**
 * @param {string} source
 * @param {object} channel
 * @returns {object}
 */
function executeCommonJs (source, channel) {
  const context = {
    module: { exports: {} },
    require: () => ({ channel: () => channel }),
  }
  vm.runInNewContext(source, context)
  return context.module.exports
}

/**
 * @param {unknown} value
 */
function throwValue (value) {
  throw value
}

/**
 * @param {string} source
 * @param {string} filename
 * @returns {Promise<void>}
 */
async function assertGeneratedSourceIsLintClean (source, filename) {
  if (!lintRuntimeSupported) return

  const eslint = new ESLint()
  const [result] = await eslint.lintText(source, {
    filePath: path.join(process.cwd(), 'packages/datadog-turbopack/test', filename),
  })
  assert.deepEqual(result.messages, [])
}
