'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { afterEach, describe, it } = require('mocha')

const { withDatadogTurbopack } = require('..')
const loader = require('../src/loader')
const { createEsmProxy, createManifest, getRelativeTargets } = require('../src/targets')

const directories = []

afterEach(() => {
  while (directories.length > 0) {
    fs.rmSync(directories.pop(), { force: true, recursive: true })
  }
})

describe('datadog-turbopack loader', () => {
  it('uses CommonJS-compatible diagnostics channel imports in ESM proxies', async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-')))
    directories.push(directory)
    const source = write(directory, 'module.mjs', 'export const value = 1')
    const proxyPath = path.join(directory, 'proxy.mjs')
    const proxy = await createEsmProxy(source, proxyPath, 'ai', 'ai', '7.0.0')

    assert.match(proxy, /import dc from /)
    assert.match(proxy, /dc\.channel\('dd-trace:bundler:load'\)/)
    assert.doesNotMatch(proxy, /import \{ channel \} from /)

    fs.writeFileSync(proxyPath, proxy)
    await import(pathToFileURL(proxyPath).href)
  })

  it('routes an internal ESM import through its generated proxy', () => {
    const directory = createPackage('openai', { type: 'module' })
    const client = write(directory, 'client.mjs', "import { Models } from './resources/models.mjs'\nexport { Models }")
    const models = write(directory, 'resources/models.mjs', 'export class Models {}')
    const proxy = write(directory, '../.cache/dd-trace/turbopack/models.mjs', 'export {}')

    const result = loader.rewriteImports(fs.readFileSync(client, 'utf8'), client, {
      [realpath(models)]: { esm: true, proxyPath: realpath(proxy) },
    })

    assert.match(result, /from "\.\.\/\.cache\/dd-trace\/turbopack\/models\.mjs"/)
  })

  it('routes a dynamic ESM import through its generated proxy', () => {
    const directory = createPackage('openai', { type: 'module' })
    const client = write(directory, 'client.mjs', "export const loadModels = () => import('./resources/models.mjs')")
    const models = write(directory, 'resources/models.mjs', 'export class Models {}')
    const proxy = write(directory, '../.cache/dd-trace/turbopack/models.mjs', 'export {}')

    const result = loader.rewriteImports(fs.readFileSync(client, 'utf8'), client, {
      [realpath(models)]: { esm: true, proxyPath: realpath(proxy) },
    })

    assert.match(result, /import\("\.\.\/\.cache\/dd-trace\/turbopack\/models\.mjs"\)/)
  })

  it('routes a commented dynamic ESM import through its generated proxy', () => {
    const directory = createPackage('openai', { type: 'module' })
    const client = write(directory, 'client.mjs', [
      "export const loadModels = () => import(/* webpackChunkName: 'models' */",
      "'./resources/models.mjs')",
    ].join(' '))
    const models = write(directory, 'resources/models.mjs', 'export class Models {}')
    const proxy = write(directory, '../.cache/dd-trace/turbopack/models.mjs', 'export {}')

    const result = loader.rewriteImports(fs.readFileSync(client, 'utf8'), client, {
      [realpath(models)]: { esm: true, proxyPath: realpath(proxy) },
    })

    assert.match(result, /import\("\.\.\/\.cache\/dd-trace\/turbopack\/models\.mjs"\)/)
  })

  it('routes an application ESM import through its generated proxy', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
    const packagePath = createPackageIn(directory, 'ai', { main: 'index.mjs', type: 'module', version: '7.0.0' })
    write(packagePath, 'index.mjs', 'export const generateText = () => {}')
    const appPath = write(directory, 'app/route.js', "import { generateText } from 'ai'")
    const manifest = await createManifest(directory)

    const result = loader.call({
      getOptions: () => ({ manifestPath: manifest.path, rewriteApplicationImports: true }),
      resourcePath: appPath,
    }, fs.readFileSync(appPath, 'utf8'))

    assert.match(result, /from "\.\.\/node_modules\/\.cache\/dd-trace\/turbopack\/build-[^/]+\/0\.mjs"/)
    assert.match(result, /sourceMappingURL=data:application\/json;base64,/)
  })

  it('routes an application CommonJS require through its generated proxy', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
    const packagePath = createPackageIn(directory, 'ai', { main: 'index.mjs', type: 'module', version: '7.0.0' })
    write(packagePath, 'index.mjs', 'export const generateText = () => {}')
    const appPath = write(directory, 'pages/api/route.js', "const { generateText } = require('ai')")
    const manifest = await createManifest(directory)

    const result = loader.call({
      getOptions: () => ({ manifestPath: manifest.path, rewriteApplicationImports: true }),
      resourcePath: appPath,
    }, fs.readFileSync(appPath, 'utf8'))

    assert.match(result, /require\("\.\.\/\.\.\/node_modules\/\.cache\/dd-trace\/turbopack\/build-[^/]+\/0\.mjs"\)/)
  })

  it('does not rewrite an application-defined require function', () => {
    const directory = createPackage('ai', { main: 'index.mjs', type: 'module' })
    const target = write(directory, 'index.mjs', 'export const generateText = () => {}')
    const proxy = write(directory, '../.cache/dd-trace/turbopack/ai.mjs', 'export {}')
    const appPath = write(path.dirname(path.dirname(directory)), 'route.js', '')
    const source = "function load (require) { return require('ai') }"

    const result = loader.rewriteImports(source, appPath, {
      [realpath(target)]: { esm: true, proxyPath: realpath(proxy) },
    })

    assert.equal(result, source)
  })

  it('preserves configured aliases for instrumented packages', () => {
    const directory = createPackage('ai', { main: 'index.mjs', type: 'module' })
    const target = write(directory, 'index.mjs', 'export const generateText = () => {}')
    const proxy = write(directory, '../.cache/dd-trace/turbopack/ai.mjs', 'export {}')
    const appPath = write(path.dirname(path.dirname(directory)), 'route.js', '')
    const source = "import { generateText } from 'ai'"

    const result = loader.rewriteImports(source, appPath, {
      [realpath(target)]: { esm: true, proxyPath: realpath(proxy) },
    }, ['ai'])

    assert.equal(result, source)
  })

  it('preserves ESM modules without an instrumented import', () => {
    const directory = createPackage('openai', { type: 'module' })
    const client = write(directory, 'client.mjs', "import { Models } from './resources/models.mjs'\nexport { Models }")
    const source = fs.readFileSync(client, 'utf8')

    const result = loader.rewriteImports(source, client, {})

    assert.equal(result, source)
  })

  it('publishes CommonJS exports through the existing bundler channel', () => {
    const directory = createPackage('ioredis')
    const resourcePath = write(directory, 'built/index.js', 'module.exports = {}')
    const manifestPath = write(directory, 'manifest.json', JSON.stringify({
      targets: {
        [realpath(resourcePath)]: {
          esm: false,
          name: 'ioredis',
          path: 'ioredis',
          version: '5.0.0',
        },
      },
    }))

    const result = loader.call({
      getOptions: () => ({ manifestPath }),
      resourcePath,
    }, 'module.exports = {}')

    assert.match(result, /dd-trace:bundler:load/)
    assert.match(result, /package: "ioredis"/)
    assert.match(result, /path: "ioredis"/)
    assert.ok(result.includes(`require(${JSON.stringify(relativeImport(
      path.dirname(resourcePath), require.resolve('dc-polyfill')
    ))})`))
  })

  it('publishes supported relative runtime modules through the bundler channel', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    const resourcePath = write(directory, 'generated/prisma/runtime/library.js', 'module.exports = {}')
    const manifestPath = write(directory, 'manifest.json', JSON.stringify({
      relativeTargets: [{
        file: 'runtime/library.js',
        name: './runtime/library.js',
        path: './runtime/library.js',
        version: '6.1.0',
      }],
      targets: {},
    }))

    const result = loader.call({
      getOptions: () => ({ manifestPath }),
      resourcePath,
    }, 'module.exports = {}')

    assert.match(result, /package: "\.\/runtime\/library\.js"/)
    assert.match(result, /path: "\.\/runtime\/library\.js"/)
  })

  it('publishes generated ESM proxies through the existing bundler channel', async () => {
    const directory = createPackage('openai', { type: 'module' })
    const resourcePath = write(directory, 'index.mjs', 'export const client = true')
    const proxyPath = write(directory, '../.cache/dd-trace/turbopack/openai.mjs', '')

    const result = await createEsmProxy(resourcePath, proxyPath, 'openai', 'openai', '5.0.0')

    assert.ok(result.includes(`from ${JSON.stringify(relativeImport(
      path.dirname(proxyPath), require.resolve('dc-polyfill')
    ))}`))
    assert.match(result, /dd-trace:bundler:load/)
    assert.match(result, /apply \(exports, patchDefault\)/)
    assert.match(result, /set\.default\?\.\(exports\)/)
    assert.doesNotMatch(result, /import-in-the-middle/)
  })

  it('applies existing rewriter instrumentation to an ESM target', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
    const packagePath = createPackageIn(directory, 'ai', { main: 'dist/index.js', type: 'module', version: '6.0.0' })
    const target = write(packagePath, 'dist/index.js', [
      'export function resolveLanguageModel (model) {',
      '  return model',
      '}',
      '',
    ].join('\n'))
    const manifest = await createManifest(directory)

    const result = loader.call({
      getOptions: () => ({ manifestPath: manifest.path }),
      resourcePath: target,
    }, fs.readFileSync(target, 'utf8'))

    assert.notEqual(result, fs.readFileSync(target, 'utf8'))
    assert.match(result, /sourceMappingURL=data:application\/json;base64,/)
  })
})

describe('datadog-turbopack configuration', () => {
  it('limits relative runtime rules to compatible package versions', () => {
    require('../../datadog-instrumentations/src/prisma')

    const supported = getRelativeTargets([{ name: '@prisma/client', version: '6.1.0' }], new Set())
    const unsupported = getRelativeTargets([{ name: '@prisma/client', version: '7.0.0' }], new Set())

    assert.deepEqual(supported, [{
      file: 'runtime/library.js',
      name: './runtime/library.js',
      path: './runtime/library.js',
      version: '6.1.0',
    }])
    assert.deepEqual(unsupported, [])
  })

  it('discovers nested copies of supported packages', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
    const nested = createPackageIn(directory, 'parent/node_modules/ioredis', {
      main: 'index.js',
      version: '5.0.0',
    })
    const target = write(nested, 'index.js', 'module.exports = {}')

    const manifest = await createManifest(directory)
    const targets = JSON.parse(fs.readFileSync(manifest.path, 'utf8')).targets

    assert.equal(targets[realpath(target)].name, 'ioredis')
  })

  it('discovers dependencies beside pnpm virtual-store packages', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
    const virtualStore = path.join(directory, 'node_modules', '.pnpm', 'parent@1', 'node_modules')
    const parent = createPackageIn(virtualStore, 'parent', { main: 'index.js', version: '1.0.0' })
    const target = createPackageIn(virtualStore, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(parent, 'index.js', 'module.exports = require("ioredis")')
    write(target, 'index.js', 'module.exports = {}')
    fs.mkdirSync(path.join(directory, 'node_modules'), { recursive: true })
    fs.symlinkSync(parent, path.join(directory, 'node_modules', 'parent'), 'dir')

    const manifest = await createManifest(directory)
    const targets = JSON.parse(fs.readFileSync(manifest.path, 'utf8')).targets

    assert.equal(targets[realpath(path.join(target, 'index.js'))].name, 'ioredis')
  })

  it('isolates artifacts between concurrent manifest generations', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
    const packagePath = createPackageIn(directory, 'ai', {
      main: 'index.mjs',
      type: 'module',
      version: '7.0.0',
    })
    write(packagePath, 'index.mjs', 'export const generateText = () => {}')

    const [first, second] = await Promise.all([createManifest(directory), createManifest(directory)])
    const firstTargets = JSON.parse(fs.readFileSync(first.path, 'utf8')).targets
    const secondTargets = JSON.parse(fs.readFileSync(second.path, 'utf8')).targets
    const firstTarget = Object.values(firstTargets).find(target => target.name === 'ai')
    const secondTarget = Object.values(secondTargets).find(target => target.name === 'ai')

    assert.notEqual(first.path, second.path)
    assert.notEqual(firstTarget.proxyPath, secondTarget.proxyPath)
    assert.ok(fs.existsSync(firstTarget.proxyPath))
    assert.ok(fs.existsSync(secondTarget.proxyPath))
  })

  it('does not generate targets for disabled integrations', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
    const packagePath = createPackageIn(directory, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packagePath, 'index.js', 'module.exports = {}')
    const previous = process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
    process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'ioredis'

    try {
      assert.deepEqual(await createManifest(directory), {})
    } finally {
      if (previous === undefined) delete process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS
      else process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = previous
    }
  })

  it('does not add rules when no supported package is installed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
    const config = { rules: { '*.js': { loaders: ['existing-loader'] } } }

    assert.strictEqual(await withDatadogTurbopack(config, directory), config)
  })

  it('leaves configuration unchanged when its cache directory cannot be created', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
    const packagePath = createPackageIn(directory, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packagePath, 'index.js', 'module.exports = {}')
    fs.writeFileSync(path.join(directory, 'node_modules', '.cache'), '')
    const config = { rules: { '*.js': { loaders: ['existing-loader'] } } }

    assert.strictEqual(await withDatadogTurbopack(config, directory), config)
  })

  it('does not require Next.js and preserves existing Turbopack settings', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
    const packagePath = createPackageIn(directory, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packagePath, 'index.js', 'module.exports = {}')

    const config = await withDatadogTurbopack({
      resolveAlias: { existing: './existing.js' },
      rules: { '*.js': { loaders: ['existing-loader'] } },
    }, directory)

    assert.equal(config.resolveAlias.existing, './existing.js')
    assert.equal(config.rules['*.js'].length, 2)
    assert.deepEqual(config.rules['*.js'][0], { loaders: ['existing-loader'] })
    assert.match(config.rules['*.js'][1].condition.all[2].path.source, /node_modules/)
  })

  it('does not add the Datadog loader twice when composed repeatedly', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
    const packagePath = createPackageIn(directory, 'ioredis', { main: 'index.js', version: '5.0.0' })
    write(packagePath, 'index.js', 'module.exports = {}')

    const once = await withDatadogTurbopack({}, directory)
    const twice = await withDatadogTurbopack(once, directory)

    for (const extension of ['*.js', '*.cjs', '*.mjs']) {
      const rules = [twice.rules[extension]].flat()
      assert.equal(rules.filter(rule => rule.loaders.some(item => item.loader.includes('datadog-turbopack'))).length, 1)
    }
  })

  it('refreshes stale Datadog rules when discovered targets change', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
    const packagePath = createPackageIn(directory, 'ai', { main: 'index.js', version: '7.0.0' })
    write(packagePath, 'index.js', 'module.exports = {}')

    const initial = await withDatadogTurbopack({}, directory)
    fs.writeFileSync(path.join(packagePath, 'package.json'), JSON.stringify({
      name: 'ai',
      main: 'index.js',
      type: 'module',
      version: '7.0.0',
    }))
    write(packagePath, 'index.js', 'export const generateText = () => {}')

    const refreshed = await withDatadogTurbopack(initial, directory)
    const rules = [refreshed.rules['*.js']].flat()
    const datadogRules = rules.filter(rule => rule.loaders?.some(item => item.loader.includes('datadog-turbopack')))

    assert.equal(datadogRules.length, 2)
    assert.ok(datadogRules.some(rule => rule.condition.all.some(condition => condition?.content)))
    assert.equal(new Set(datadogRules.flatMap(rule => rule.loaders.map(item => item.options.manifestHash))).size, 1)
  })

  it('adds a Node-only rule for application ESM imports and requires', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
    const packagePath = createPackageIn(directory, 'ai', { main: 'index.mjs', type: 'module', version: '7.0.0' })
    write(packagePath, 'index.mjs', 'export const generateText = () => {}')

    const config = await withDatadogTurbopack({}, directory)
    const rules = [config.rules['*.js']].flat()
    const applicationRule = rules.find(rule => rule.condition.all.some(condition => condition?.not === 'foreign'))

    assert.deepEqual(applicationRule.condition.all.slice(0, 2), ['node', { not: 'foreign' }])
    assert.match('import { generateText } from "ai"', applicationRule.condition.all[2].content)
    assert.match('const { generateText } = require("ai")', applicationRule.condition.all[2].content)
    assert.doesNotMatch('import { something } from "unrelated"', applicationRule.condition.all[2].content)
    assert.equal(applicationRule.loaders[0].options.rewriteApplicationImports, true)
    assert.match(applicationRule.loaders[0].options.manifestHash, /^[a-f0-9]{64}$/)
    assert.deepEqual(applicationRule.loaders[0].options.aliases, [])
    assert.equal(config.rules['*.ts'], undefined)
    assert.equal(config.rules['*.jsx'], undefined)
    assert.equal(config.rules['*.tsx'], undefined)
  })

  it('does not add rules for unsupported source formats', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
    const packagePath = createPackageIn(directory, 'ai', { main: 'index.mjs', type: 'module', version: '7.0.0' })
    write(packagePath, 'index.mjs', 'export const generateText = () => {}')

    const config = await withDatadogTurbopack({}, directory)

    assert.deepEqual(
      Object.keys(config.rules).sort(),
      ['*.cjs', '*.js', '*.mjs']
    )
  })
})

function createPackage (name, manifest = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
  directories.push(directory)

  return createPackageIn(directory, name, manifest)
}

function createPackageIn (directory, name, manifest = {}) {
  const packagePath = path.join(directory, 'node_modules', name)
  fs.mkdirSync(packagePath, { recursive: true })
  fs.writeFileSync(path.join(packagePath, 'package.json'), JSON.stringify({ name, ...manifest }))
  return packagePath
}

function write (directory, relativePath, content) {
  const target = path.resolve(directory, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  return target
}

function realpath (file) {
  return fs.realpathSync(file).replaceAll('\\', '/')
}

function relativeImport (from, to) {
  let value = path.relative(from, to).replaceAll('\\', '/')
  if (!value.startsWith('.')) value = `./${value}`
  return value
}
