'use strict'

const assert = require('node:assert')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { afterEach, beforeEach, describe, it } = require('node:test')

const { instrumentBuildOutput } = require('./builder')

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
})
