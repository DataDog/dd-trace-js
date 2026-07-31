'use strict'

const assert = require('node:assert')
const fs = require('node:fs/promises')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')

const { build, instrumentBuildOutput, mergeNodeOptions, validateTracerRoot } = require('./builder')

describe('Vercel Next Builder prototype', () => {
  let outputPath
  let tracerRoot
  let workPath

  beforeEach(async () => {
    outputPath = await fs.mkdtemp(path.join(os.tmpdir(), 'dd-vercel-build-output-'))
    workPath = path.join(outputPath, 'work')
    tracerRoot = path.join(workPath, 'packages', 'node_modules', 'dd-trace')

    await fs.mkdir(tracerRoot, { recursive: true })
    await fs.writeFile(path.join(tracerRoot, 'package.json'), JSON.stringify({
      name: 'dd-trace',
      version: '1.0.0',
      dependencies: { 'tracer-dependency': '1.0.0' },
      optionalDependencies: { 'missing-optional-dependency': '1.0.0' },
    }))
    await fs.writeFile(path.join(tracerRoot, 'initialize.mjs'), 'globalThis.__datadogInitialized = true\n')
    await fs.mkdir(path.join(tracerRoot, 'vendor'), { recursive: true })
    await fs.writeFile(path.join(tracerRoot, 'vendor', 'runtime.js'), 'module.exports = true\n')

    const dependencyRoot = path.join(workPath, 'packages', 'node_modules', 'tracer-dependency')
    await fs.mkdir(dependencyRoot, { recursive: true })
    await fs.writeFile(path.join(dependencyRoot, 'package.json'), JSON.stringify({
      name: 'tracer-dependency',
      version: '1.0.0',
    }))
    await fs.writeFile(path.join(dependencyRoot, 'index.js'), 'module.exports = true\n')
  })

  afterEach(async () => {
    await fs.rm(outputPath, { force: true, recursive: true })
  })

  it('packages dd-trace and preloads it for Node functions without changing handlers', async () => {
    const nodeFunction = path.join(outputPath, 'functions', 'api', 'ping.func')
    const edgeFunction = path.join(outputPath, 'functions', 'api', 'edge.func')
    await fs.mkdir(nodeFunction, { recursive: true })
    await fs.mkdir(edgeFunction, { recursive: true })
    await fs.writeFile(path.join(nodeFunction, '.vc-config.json'), JSON.stringify({
      environment: { NODE_OPTIONS: '--enable-source-maps', USER_SETTING: 'preserved' },
      handler: '___next_launcher.cjs',
      runtime: 'nodejs22.x',
    }))
    await fs.writeFile(path.join(edgeFunction, '.vc-config.json'), JSON.stringify({
      handler: 'index.js',
      runtime: 'edge',
    }))

    await instrumentBuildOutput(outputPath, tracerRoot, workPath)

    const nodeConfig = JSON.parse(await fs.readFile(path.join(nodeFunction, '.vc-config.json'), 'utf8'))
    const edgeConfig = JSON.parse(await fs.readFile(path.join(edgeFunction, '.vc-config.json'), 'utf8'))

    assert.strictEqual(nodeConfig.handler, '___next_launcher.cjs')
    assert.strictEqual(
      nodeConfig.environment.NODE_OPTIONS,
      '--import=dd-trace/initialize.mjs --enable-source-maps'
    )
    assert.strictEqual(nodeConfig.environment.USER_SETTING, 'preserved')
    assert.strictEqual(
      nodeConfig.filePathMap['node_modules/dd-trace/initialize.mjs'],
      '.datadog/vercel-runtime/node_modules/dd-trace/initialize.mjs'
    )
    assert.strictEqual(
      nodeConfig.filePathMap['node_modules/tracer-dependency/index.js'],
      '.datadog/vercel-runtime/node_modules/tracer-dependency/index.js'
    )
    assert.strictEqual(
      nodeConfig.filePathMap['node_modules/dd-trace/vendor/runtime.js'],
      '.datadog/vercel-runtime/node_modules/dd-trace/vendor/runtime.js'
    )
    await fs.access(path.join(workPath, nodeConfig.filePathMap['node_modules/dd-trace/initialize.mjs']))
    await assert.rejects(fs.access(path.join(nodeFunction, 'node_modules', 'dd-trace')))

    assert.deepStrictEqual(edgeConfig, { handler: 'index.js', runtime: 'edge' })
    await assert.rejects(fs.access(path.join(edgeFunction, 'node_modules', 'dd-trace')))
  })

  it('does not add the preload twice', async () => {
    assert.strictEqual(
      mergeNodeOptions('--import=dd-trace/initialize.mjs --enable-source-maps'),
      '--import=dd-trace/initialize.mjs --enable-source-maps'
    )
  })

  it('rejects an installed tracer that cannot be preloaded', async () => {
    await fs.rm(path.join(tracerRoot, 'initialize.mjs'))

    await assert.rejects(
      validateTracerRoot(tracerRoot),
      /dd-trace 1\.0\.0 does not provide initialize\.mjs; install a supported version/
    )
  })

  it('preserves a static-only Build Output directory', async () => {
    await fs.mkdir(path.join(outputPath, 'static'), { recursive: true })

    await instrumentBuildOutput(outputPath, tracerRoot, workPath)

    await fs.access(path.join(outputPath, 'static'))
    await assert.rejects(fs.access(path.join(workPath, '.datadog')))
  })

  it('instruments the public directory returned by the Next Builder', async () => {
    const functionPath = path.join(outputPath, 'functions', 'api.func')
    const originalLoad = Module._load
    const options = { workPath }
    const result = { buildOutputPath: outputPath, buildOutputVersion: 3 }
    await fs.mkdir(functionPath, { recursive: true })
    await fs.writeFile(path.join(functionPath, '.vc-config.json'), JSON.stringify({
      handler: '___next_launcher.cjs',
      runtime: 'nodejs22.x',
    }))

    Module._load = (request, parent, isMain) => {
      if (request === '@vercel/next') {
        return {
          build: async receivedOptions => {
            assert.strictEqual(receivedOptions, options)
            return result
          },
        }
      }
      return originalLoad(request, parent, isMain)
    }

    const originalResolve = Module._resolveFilename
    Module._resolveFilename = (request, parent, isMain, options) => {
      if (request === 'dd-trace/package.json') return path.join(tracerRoot, 'package.json')
      return originalResolve(request, parent, isMain, options)
    }

    try {
      assert.strictEqual(await build(options), result)
    } finally {
      Module._load = originalLoad
      Module._resolveFilename = originalResolve
    }

    const config = JSON.parse(await fs.readFile(path.join(functionPath, '.vc-config.json'), 'utf8'))
    assert.strictEqual(config.handler, '___next_launcher.cjs')
    assert.strictEqual(config.environment.NODE_OPTIONS, '--import=dd-trace/initialize.mjs')
    assert.ok(config.filePathMap['node_modules/dd-trace/initialize.mjs'])
  })
})
