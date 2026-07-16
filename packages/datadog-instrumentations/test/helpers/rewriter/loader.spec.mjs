import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { channel } from 'dc-polyfill'
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

  it('reports successful rewrites with activation metadata', async () => {
    const url = createAiModuleUrl()
    const loadChannel = channel('dd-trace:instrumentation:load')
    const messages = []
    const onLoad = message => messages.push(message)
    loadChannel.subscribe(onLoad)

    try {
      const result = await load(url, { format: 'module' }, () => ({ format: 'module', source }))

      assertRewritten(result.source)
      assert.deepStrictEqual(messages, [{ name: 'ai', version: '4.0.0', file: 'dist/index.mjs' }])
    } finally {
      loadChannel.unsubscribe(onLoad)
    }
  })

  it('deduplicates activation by package, version, and file', () => {
    const url = createModuleUrl('ai', '4.0.1', 'dist/index.mjs')
    const loadChannel = channel('dd-trace:instrumentation:load')
    const messages = []
    const onLoad = message => messages.push(message)
    loadChannel.subscribe(onLoad)

    try {
      const first = loadSync(url, { format: 'module' }, () => ({ format: 'module', source }))
      const second = loadSync(url, { format: 'module' }, () => ({ format: 'module', source }))

      assertRewritten(first.source)
      assertRewritten(second.source)
      assert.deepStrictEqual(messages, [{ name: 'ai', version: '4.0.1', file: 'dist/index.mjs' }])
    } finally {
      loadChannel.unsubscribe(onLoad)
    }
  })

  it('does not activate unmatched or failed rewrites', () => {
    const loadChannel = channel('dd-trace:instrumentation:load')
    const messages = []
    const onLoad = message => messages.push(message)
    loadChannel.subscribe(onLoad)

    try {
      const unmatchedUrl = createModuleUrl('unmatched', '1.0.0', 'dist/index.mjs')
      const unmatched = loadSync(unmatchedUrl, { format: 'module' }, () => ({ format: 'module', source }))
      const failedUrl = createModuleUrl('bullmq', '5.66.0', 'dist/esm/classes/queue.js')
      const failed = loadSync(failedUrl, { format: 'module' }, () => ({ format: 'module', source }))

      assert.strictEqual(unmatched.source, source)
      assert.strictEqual(failed.source, source)
      assert.deepStrictEqual(messages, [])
    } finally {
      loadChannel.unsubscribe(onLoad)
    }
  })

  it('activates subscribers before the first instrumented ESM call', () => {
    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-activation-'))
    const packageDirectory = join(root, 'node_modules', 'bullmq')
    const queueFile = join(packageDirectory, 'dist', 'esm', 'classes', 'queue.js')

    mkdirSync(dirname(queueFile), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"5.66.0","type":"module"}')
    const dcPolyfillPath = JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))
    writeFileSync(queueFile, `
      export class Queue {
        async add () { return 'added' }
      }
    `)
    writeFileSync(join(root, 'main.mjs'), `
      import { createRequire } from 'node:module'
      const require = createRequire(import.meta.url)
      const { channel, tracingChannel } = require(${dcPolyfillPath})
      let starts = 0
      channel('dd-trace:instrumentation:load').subscribe(({ name }) => {
        if (name === 'bullmq') {
          tracingChannel('orchestrion:bullmq:Queue_add').subscribe({ start () { starts++ } })
        }
      })
      const { Queue } = await import('./node_modules/bullmq/dist/esm/classes/queue.js')
      await new Queue().add()
      console.log(starts)
    `)

    const result = spawnSync(process.execPath, [join(root, 'main.mjs')], {
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
  return createModuleUrl('ai', '4.0.0', 'dist/index.mjs')
}

function createModuleUrl (name, version, file) {
  const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-'))
  const packageDirectory = join(root, 'node_modules', ...name.split('/'))

  mkdirSync(dirname(join(packageDirectory, file)), { recursive: true })
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ version }))

  return pathToFileURL(join(packageDirectory, file)).href
}

function assertRewritten (rewrittenSource) {
  assert.match(rewrittenSource, /from "file:\/\/.+dc-polyfill/)
  assert.match(rewrittenSource, /tr_ch_apm_tracingChannel/)
  assert.match(rewrittenSource, /orchestrion:ai:getTracer/)
}
