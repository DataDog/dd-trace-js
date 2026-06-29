import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { supportsSyncHooks } from 'import-in-the-middle/create-hook.mjs'
import { before, describe, it } from 'mocha'

const require = createRequire(import.meta.url)
const source = 'export function getTracer () { return "tracer" }\n'
const testDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(testDirectory, '../../../../..')

describe('rewriter loader', () => {
  let load
  let loadSync

  before(async () => {
    // require(esm) keeps the loader on nyc's CommonJS instrumentation path so its
    // transforms count as covered. Without require(esm), nyc's .mjs require extension
    // feeds the module to the CommonJS compiler, which throws on its ESM `import`.
    // The property is absent (undefined) before Node 20.19/22.10, which is the false branch.
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    const rewriterLoader = process.features.require_module
      ? require('../../../src/helpers/rewriter/loader.mjs')
      : await import('../../../src/helpers/rewriter/loader.mjs')
    load = rewriterLoader.load
    loadSync = rewriterLoader.loadSync
  })

  it('rewrites async loader results', async () => {
    const url = createAiModuleUrl()
    const result = await load(url, { format: 'module' }, () => ({ format: 'module', source }))

    assertRewritten(result.source)
  })

  it('rewrites sync loader results', () => {
    const url = createAiModuleUrl()
    const result = loadSync(url, { format: 'module' }, () => ({ format: 'module', source }))

    assertRewritten(result.source)
  })

  it('does not rewrite CommonJS require loads in the sync loader hook', () => {
    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-cjs-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0","main":"dist/index.js"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), `
      function getTracer () { return 'tracer' }
      module.exports = { getTracer }
    `)
    writeFileSync(join(root, 'main.js'), `
      require(${JSON.stringify(join(
        repositoryRoot,
        'packages',
        'datadog-instrumentations',
        'src',
        'helpers',
        'rewriter',
        'loader'
      ))})
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      let starts = 0

      channel.subscribe({ start () { starts++ } })
      require('ai').getTracer()
      console.log(starts)
    `)

    const result = spawnSync(process.execPath, [join(root, 'main.js')], {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: `--import ${join(repositoryRoot, 'register.js')}`,
      },
      encoding: 'utf8',
    })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.strictEqual(result.stdout.trim(), '1')
  })

  it('does not rewrite CommonJS entrypoint loads in the sync loader hook', () => {
    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-cjs-entrypoint-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), `
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      let starts = 0

      channel.subscribe({ start () { starts++ } })

      function getTracer () { return 'tracer' }
      getTracer()
      console.log(starts)
    `)

    const result = spawnSync(process.execPath, [join(packageDirectory, 'dist', 'index.js')], {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: [
          `--import ${join(repositoryRoot, 'register.js')}`,
          `-r ${join(repositoryRoot, 'packages', 'datadog-instrumentations', 'src', 'helpers', 'rewriter', 'loader')}`,
        ].join(' '),
      },
      encoding: 'utf8',
    })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.strictEqual(result.stdout.trim(), '1')
  })

  it('rewrites ESM modules loaded from CommonJS in the sync loader hook', function () {
    if (!supportsSyncHooks()) {
      this.skip()
    }

    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-cjs-esm-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0","type":"module","main":"dist/index.js"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), source)
    writeFileSync(join(root, 'main.js'), `
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      let starts = 0

      channel.subscribe({ start () { starts++ } })
      require('ai').getTracer()
      console.log(starts)
    `)

    const result = spawnSync(process.execPath, [join(root, 'main.js')], {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS: `--import ${join(repositoryRoot, 'register.js')}`,
      },
      encoding: 'utf8',
    })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.strictEqual(result.stdout.trim(), '1')
  })
})

function createAiModuleUrl () {
  const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-'))
  const packageDirectory = join(root, 'node_modules', 'ai')

  mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
  writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0"}')

  return pathToFileURL(join(packageDirectory, 'dist', 'index.mjs')).href
}

function assertRewritten (rewrittenSource) {
  assert.match(rewrittenSource, /from "file:\/\/.+dc-polyfill/)
  assert.match(rewrittenSource, /tr_ch_apm_tracingChannel/)
  assert.match(rewrittenSource, /orchestrion:ai:getTracer/)
}
