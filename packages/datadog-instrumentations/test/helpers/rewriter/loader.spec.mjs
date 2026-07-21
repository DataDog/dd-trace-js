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
const commonJSSource = 'function getTracer () { return "tracer" }\nmodule.exports = { getTracer }\n'
const decoratedCommonJSSource = `#!/usr/bin/env node
'use strict'
${commonJSSource}//# sourceMappingURL=data:application/json;base64,e30=
`
const testDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(testDirectory, '../../../../..')
const originalCompileSymbol = 'dd-trace.test.rewriter.original-compile'
const [nodeMajor, nodeMinor, nodePatch] = process.versions.node.split('.').map(Number)
const isSyncLoaderVersionSupported = nodeMajor >= 26 ||
  (nodeMajor === 25 && nodeMinor >= 1) ||
  (nodeMajor === 24 && (nodeMinor > 11 || (nodeMinor === 11 && nodePatch >= 1))) ||
  (nodeMajor === 22 && (nodeMinor > 22 || (nodeMinor === 22 && nodePatch >= 3)))
const supportsSynchronousLoader = isSyncLoaderVersionSupported && supportsSyncHooks()

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

  it('keeps CommonJS async loader results unchanged', async () => {
    const url = createAiModuleUrl()
    const result = await load(url, { format: 'commonjs' }, () => ({ format: 'commonjs', source: commonJSSource }))

    assert.strictEqual(result.source, commonJSSource)
  })

  it('rewrites CommonJS only when enabled for the sync loader', () => {
    const url = createAiModuleUrl()
    const unchanged = loadSync(
      url,
      { format: 'commonjs' },
      () => ({ format: 'commonjs', source: commonJSSource })
    )
    const rewritten = loadSync(
      url,
      { format: 'commonjs' },
      () => ({ format: 'commonjs', source: commonJSSource }),
      true
    )
    const rewrittenFromContext = loadSync(
      url,
      { format: 'commonjs' },
      () => ({ source: commonJSSource }),
      true
    )
    const rewrittenWithPreamble = loadSync(
      url,
      { format: 'commonjs' },
      () => ({ format: 'commonjs', source: decoratedCommonJSSource }),
      true
    )

    assert.strictEqual(unchanged.source, commonJSSource)
    assertCommonJSRewritten(rewritten.source)
    assertCommonJSRewritten(rewrittenFromContext.source)
    assertCommonJSRewritten(rewrittenWithPreamble.source)
    assert.strictEqual(rewrittenWithPreamble.source.split('\n')[0], '#!/usr/bin/env node')
    assert.match(rewrittenWithPreamble.source.split('\n')[1], /^'use strict';$/)
    assert.match(rewrittenWithPreamble.source.trimEnd().split('\n').at(-1), /^\/\/# sourceMappingURL=/)
  })

  it('rewrites a CommonJS package once without installing the compile hook', function () {
    if (!supportsSynchronousLoader) {
      this.skip()
    }

    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-cjs-'))
    const packageDirectory = join(root, 'node_modules', 'ai')

    mkdirSync(join(packageDirectory, 'dist'), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), '{"version":"4.0.0","main":"dist/index.js"}')
    writeFileSync(join(packageDirectory, 'dist', 'index.js'), decoratedCommonJSSource)
    writeCompileCapture(root)
    writeFileSync(join(root, 'main.js'), `
      const Module = require('node:module')
      const { tracingChannel } = require(${JSON.stringify(join(repositoryRoot, 'node_modules', 'dc-polyfill'))})
      const channel = tracingChannel('orchestrion:ai:getTracer')
      const originalCompile = globalThis[Symbol.for(${JSON.stringify(originalCompileSymbol)})]
      let starts = 0

      channel.subscribe({ start () { starts++ } })
      const value = require('ai').getTracer()
      require(${JSON.stringify(join(repositoryRoot, 'packages', 'datadog-instrumentations'))})
      console.log(JSON.stringify({
        compileUnchanged: Module.prototype._compile === originalCompile,
        starts,
        value,
      }))
    `)

    const result = runFixture(root, 'main.js', {
      NODE_OPTIONS: [
        `--require ${join(root, 'capture-compile.cjs')}`,
        `--import ${join(repositoryRoot, 'register.js')}`,
      ].join(' '),
    })

    assert.deepStrictEqual(result, {
      compileUnchanged: true,
      starts: 1,
      value: 'tracer',
    })
  })

  it('rewrites CommonJS entrypoint loads in the sync loader hook', function () {
    if (!supportsSynchronousLoader) {
      this.skip()
    }

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
      const value = getTracer()
      console.log(JSON.stringify({ starts, value }))
    `)

    const result = runFixture(root, join(packageDirectory, 'dist', 'index.js'), {
      NODE_OPTIONS: `--import ${join(repositoryRoot, 'register.js')}`,
    })

    assert.deepStrictEqual(result, { starts: 1, value: 'tracer' })
  })

  it('rewrites ESM modules loaded from CommonJS in the sync loader hook', function () {
    if (!supportsSynchronousLoader) {
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
        OTEL_LOGS_EXPORTER: '',
        OTEL_METRICS_EXPORTER: '',
        OTEL_TRACES_EXPORTER: '',
        NODE_OPTIONS: `--import ${join(repositoryRoot, 'register.js')}`,
      },
      encoding: 'utf8',
    })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.strictEqual(result.stdout.trim(), '1')
  })

  it('installs the compile hook when synchronous registration is not active', () => {
    const root = mkdtempSync(join(tmpdir(), 'dd-rewriter-loader-fallback-'))

    writeFileSync(join(root, 'main.js'), `
      const Module = require('node:module')
      const originalCompile = Module.prototype._compile
      require(${JSON.stringify(join(repositoryRoot, 'packages', 'datadog-instrumentations'))})
      console.log(JSON.stringify({ compileChanged: Module.prototype._compile !== originalCompile }))
    `)

    const result = runFixture(root)

    assert.deepStrictEqual(result, { compileChanged: true })
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

function assertCommonJSRewritten (rewrittenSource) {
  assert.match(rewrittenSource, /require\(".*dc-polyfill/)
  assert.match(rewrittenSource, /tr_ch_apm_tracingChannel/)
  assert.match(rewrittenSource, /orchestrion:ai:getTracer/)
}

function writeCompileCapture (root) {
  writeFileSync(join(root, 'capture-compile.cjs'), `
    const Module = require('node:module')
    globalThis[Symbol.for(${JSON.stringify(originalCompileSymbol)})] = Module.prototype._compile
  `)
}

function runFixture (root, entrypoint = 'main.js', environment = {}) {
  const result = spawnSync(process.execPath, [entrypoint], {
    cwd: root,
    env: {
      ...process.env,
      OTEL_LOGS_EXPORTER: '',
      OTEL_METRICS_EXPORTER: '',
      OTEL_TRACES_EXPORTER: '',
      ...environment,
    },
    encoding: 'utf8',
  })

  assert.strictEqual(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim())
}
