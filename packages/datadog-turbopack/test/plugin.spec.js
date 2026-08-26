'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { afterEach, describe, it } = require('mocha')

const { withDatadogTurbopack } = require('..')
const loader = require('../src/loader')
const { createEsmProxy, createManifest } = require('../src/targets')

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

    assert.match(result, /from "\.\.\/node_modules\/\.cache\/dd-trace\/turbopack\/0\.mjs"/)
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

    assert.match(result, /require\("\.\.\/\.\.\/node_modules\/\.cache\/dd-trace\/turbopack\/0\.mjs"\)/)
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

  it('publishes generated ESM proxies through the existing bundler channel', async () => {
    const directory = createPackage('openai', { type: 'module' })
    const resourcePath = write(directory, 'index.mjs', 'export const client = true')
    const proxyPath = write(directory, '../.cache/dd-trace/turbopack/openai.mjs', '')

    const result = await createEsmProxy(resourcePath, proxyPath, 'openai', 'openai', '5.0.0')

    assert.ok(result.includes(`from ${JSON.stringify(relativeImport(
      path.dirname(proxyPath), require.resolve('dc-polyfill')
    ))}`))
    assert.match(result, /dd-trace:bundler:load/)
    assert.match(result, /apply \(exports\)/)
    assert.doesNotMatch(result, /import-in-the-middle/)
  })
})

describe('datadog-turbopack configuration', () => {
  it('does not add rules when no supported package is installed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-turbopack-'))
    directories.push(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{}')
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
