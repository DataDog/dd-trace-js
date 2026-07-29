'use strict'

const assert = require('node:assert')
const fs = require('node:fs/promises')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')

const { build, instrumentBuildOutput } = require('./builder')

describe('Vercel Next Builder prototype', () => {
  let outputPath

  beforeEach(async () => {
    outputPath = await fs.mkdtemp(path.join(os.tmpdir(), 'dd-vercel-build-output-'))
  })

  afterEach(async () => {
    await fs.rm(outputPath, { force: true, recursive: true })
  })

  it('preloads dd-trace for Node functions and preserves Edge functions', async () => {
    const nodeFunction = path.join(outputPath, 'functions', 'api', 'ping.func')
    const edgeFunction = path.join(outputPath, 'functions', 'api', 'edge.func')
    const orderPath = path.join(nodeFunction, 'initialization-order')
    await fs.mkdir(nodeFunction, { recursive: true })
    await fs.mkdir(edgeFunction, { recursive: true })
    await fs.mkdir(path.join(nodeFunction, 'node_modules', 'dd-trace'), { recursive: true })
    await fs.writeFile(path.join(nodeFunction, '.vc-config.json'), JSON.stringify({
      handler: '___next_launcher.cjs',
      runtime: 'nodejs22.x',
    }))
    await fs.writeFile(
      path.join(nodeFunction, 'node_modules', 'dd-trace', 'init.js'),
      `require('node:fs').appendFileSync(${JSON.stringify(orderPath)}, 'dd-trace\\n')\n`
    )
    await fs.writeFile(
      path.join(nodeFunction, '___next_launcher.cjs'),
      `require('node:fs').appendFileSync(${JSON.stringify(orderPath)}, 'next\\n')\n`
    )
    await fs.writeFile(path.join(edgeFunction, '.vc-config.json'), JSON.stringify({
      handler: 'index.js',
      runtime: 'edge',
    }))

    await instrumentBuildOutput(outputPath)

    const nodeConfig = JSON.parse(await fs.readFile(path.join(nodeFunction, '.vc-config.json'), 'utf8'))
    const edgeConfig = JSON.parse(await fs.readFile(path.join(edgeFunction, '.vc-config.json'), 'utf8'))
    require(path.join(nodeFunction, nodeConfig.handler))

    assert.strictEqual(nodeConfig.handler, '___datadog_next_launcher.cjs')
    assert.deepStrictEqual((await fs.readFile(orderPath, 'utf8')).trim().split('\n'), ['dd-trace', 'next'])
    assert.deepStrictEqual(edgeConfig, { handler: 'index.js', runtime: 'edge' })
    await assert.rejects(fs.access(path.join(edgeFunction, '___datadog_next_launcher.cjs')))
  })

  it('does not wrap an already transformed Node function again', async () => {
    const functionPath = path.join(outputPath, 'functions', 'api.func')
    await fs.mkdir(functionPath, { recursive: true })
    await fs.writeFile(path.join(functionPath, '.vc-config.json'), JSON.stringify({
      handler: '___datadog_next_launcher.cjs',
      runtime: 'nodejs22.x',
    }))

    await instrumentBuildOutput(outputPath)

    await assert.rejects(fs.access(path.join(functionPath, '___datadog_next_launcher.cjs')))
  })

  it('preserves a static-only Build Output directory', async () => {
    await fs.mkdir(path.join(outputPath, 'static'), { recursive: true })

    await instrumentBuildOutput(outputPath)

    await fs.access(path.join(outputPath, 'static'))
  })

  it('instruments the public directory returned by the Next Builder', async () => {
    const functionPath = path.join(outputPath, 'functions', 'api.func')
    const originalLoad = Module._load
    const options = { workPath: '/app' }
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

    try {
      assert.strictEqual(await build(options), result)
    } finally {
      Module._load = originalLoad
    }

    const config = JSON.parse(await fs.readFile(path.join(functionPath, '.vc-config.json'), 'utf8'))
    assert.strictEqual(config.handler, '___datadog_next_launcher.cjs')
  })
})
