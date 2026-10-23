#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const path = require('node:path')

const webpack = require('webpack')
const { SourceMapConsumer } = require('source-map')
const DatadogWebpackPlugin = require('../../webpack')
const { FakeAgent } = require('../helpers')
const experiments = require('./webpack-experiments')

const TEST_DIR = __dirname
const OUTPUTS = [
  'builtins-cjs-bundled.js',
  'builtins-cjs-external.js',
  'builtins-esm-bundled.mjs',
  'builtins-esm-external.mjs',
  'builtins-cjs-external.cjs',
]
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')))

/**
 * @param {{ entry: string, filename: string, moduleOutput?: boolean, externalizeTracer?: boolean }} options
 */
function compile ({ entry, filename, moduleOutput = false, externalizeTracer = false }) {
  const config = {
    mode: 'development',
    entry: path.join(TEST_DIR, entry),
    target: 'node',
    externalsType: 'commonjs',
    devtool: 'source-map',
    experiments: { ...experiments, ...(moduleOutput && { outputModule: true }) },
    output: {
      filename,
      path: TEST_DIR,
      hashFunction: 'sha256',
      ...(moduleOutput && {
        module: true,
        chunkFormat: 'module',
        chunkLoading: 'import',
        environment: { module: true, dynamicImport: true },
      }),
    },
    externals: [
      ({ request, dependencyType }, callback) => {
        if (builtins.has(request.replace(/^node:/, ''))) {
          // Preserve real native ESM views for imports and CommonJS exports for tracer internals.
          callback(null, request, moduleOutput && dependencyType === 'esm' ? 'module' : 'node-commonjs')
          return
        }
        callback()
      },
      externalizeTracer && (({ request }, callback) => {
        if (request === '../..' || request === '../../index.js') {
          callback(null, `node-commonjs ${path.resolve(TEST_DIR, '../..')}`)
          return
        }
        callback()
      }),
    ].filter(Boolean),
    plugins: [new DatadogWebpackPlugin()],
  }

  return new Promise((resolve, reject) => {
    const compiler = webpack(config)
    compiler.run((error, stats) => {
      compiler.close(closeError => {
        if (error || closeError) {
          reject(error || closeError)
          return
        }
        if (stats.hasErrors()) {
          reject(new Error(stats.toString({ errors: true })))
          return
        }
        resolve()
      })
    })
  })
}

/**
 * @param {string} filename
 * @param {import('../helpers/fake-agent')} agent
 * @param {boolean} [preload]
 */
function runBundle (filename, agent, preload = false) {
  const spans = []
  const message = agent.assertMessageReceived(({ payload }) => {
    spans.push(...payload.flat())
    assert.ok(spans.some(span => span.name === 'http.request'), 'expected an HTTP client span')
    assert.ok(spans.some(span => span.name === 'web.request'), 'expected an HTTP server span')
    assert.ok(spans.some(span => span.name === 'dns.lookup'), 'expected a DNS lookup span')
  }, 10_000)

  const args = preload ? ['--require', require.resolve('../../init')] : []
  args.push(path.join(TEST_DIR, filename))
  const child = spawn(process.execPath, args, {
    cwd: TEST_DIR,
    env: {
      ...process.env,
      DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`,
      DD_TRACE_FLUSH_INTERVAL: '100',
      DD_REMOTE_CONFIGURATION_ENABLED: 'false',
      DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
    },
    stdio: 'inherit',
  })

  const exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${filename} exited with status ${code}`))
    })
  })

  return Promise.all([message, exit])
}

/**
 * @param {string} filename
 * @param {string} entry
 */
function assertSourceMap (filename, entry) {
  const output = fs.readFileSync(path.join(TEST_DIR, filename), 'utf8')
  const source = fs.readFileSync(path.join(TEST_DIR, entry), 'utf8')
  const marker = 'WEBPACK_BUILTIN_SOURCE_MAP_MARKER'
  const generatedIndex = output.indexOf(marker)
  const sourceIndex = source.indexOf(marker)

  assert.notEqual(generatedIndex, -1, 'expected source map marker in generated asset')
  assert.notEqual(sourceIndex, -1, 'expected source map marker in entry source')

  const map = JSON.parse(fs.readFileSync(path.join(TEST_DIR, `${filename}.map`), 'utf8'))
  const consumer = new SourceMapConsumer(map)
  const generatedPosition = {
    line: output.slice(0, generatedIndex).split('\n').length,
    column: generatedIndex - output.lastIndexOf('\n', generatedIndex - 1) - 1,
  }
  const originalPosition = consumer.originalPositionFor(generatedPosition)
  consumer.destroy?.()

  assert.equal(originalPosition.line, source.slice(0, sourceIndex).split('\n').length)
  assert.ok(originalPosition.source.includes(entry), `expected source map to point to ${entry}`)
}

async function main () {
  const agent = await new FakeAgent().start()
  try {
    const builds = [
      { entry: 'builtins-cjs.js', filename: OUTPUTS[0] },
      { entry: 'builtins-cjs.js', filename: OUTPUTS[1], externalizeTracer: true },
      { entry: 'builtins-esm.mjs', filename: OUTPUTS[2], moduleOutput: true },
      { entry: 'builtins-esm.mjs', filename: OUTPUTS[3], moduleOutput: true, externalizeTracer: true },
      { entry: 'builtins-cjs.js', filename: OUTPUTS[4], externalizeTracer: true },
    ]

    for (const options of builds) {
      await compile(options)

      const output = fs.readFileSync(path.join(TEST_DIR, options.filename), 'utf8')
      assert.ok(output.includes('Symbol.for("dd-trace:bundler")'), `expected ${options.filename} to be marked`)
      assertSourceMap(options.filename, options.entry)

      await runBundle(options.filename, agent)
      if (options.externalizeTracer) await runBundle(options.filename, agent, true)
    }

    console.log('ok')
  } finally {
    await agent.stop()
    for (const filename of OUTPUTS) {
      fs.rmSync(path.join(TEST_DIR, filename), { force: true })
      fs.rmSync(path.join(TEST_DIR, `${filename}.map`), { force: true })
    }
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
