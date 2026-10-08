'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { afterEach, describe, it } = require('mocha')

const root = path.resolve(__dirname, '../../../..')
const vendoredDirectory = path.join(root, 'vendor', 'dist', 'opentracing')
const typeScriptArguments = [
  require.resolve('typescript/bin/tsc'),
  '--module', 'nodenext',
  '--moduleResolution', 'nodenext',
  '--noEmit',
  '--strict',
  '--target', 'es2020',
  '--types', 'node',
  'test.ts',
]

function declarations (directory, relative = '') {
  const files = []

  for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const entryPath = path.join(relative, entry.name)

    if (entry.isDirectory()) {
      files.push(...declarations(directory, entryPath))
    } else if (entry.name.endsWith('.d.ts')) {
      files.push(entryPath)
    }
  }

  return files.sort()
}

function copyPackage (fixture, packageName, destination = packageName) {
  const source = path.join(root, 'node_modules', packageName)
  const target = path.join(fixture, 'node_modules', destination)

  mkdirSync(path.dirname(target), { recursive: true })
  cpSync(source, target, { recursive: true })
}

function copyTracerPackage (fixture) {
  const packageDirectory = path.join(fixture, 'node_modules', 'dd-trace')

  mkdirSync(path.join(packageDirectory, 'ext'), { recursive: true })
  mkdirSync(path.join(packageDirectory, 'vendor', 'dist'), { recursive: true })
  copyFileSync(path.join(root, 'index.d.ts'), path.join(packageDirectory, 'index.d.ts'))
  copyFileSync(path.join(root, 'ext', 'formats.d.ts'), path.join(packageDirectory, 'ext', 'formats.d.ts'))
  cpSync(vendoredDirectory, path.join(packageDirectory, 'vendor', 'dist', 'opentracing'), {
    recursive: true,
  })
  writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({
    name: 'dd-trace',
    types: 'index.d.ts',
  }))

  copyPackage(fixture, '@opentelemetry/api')
  copyPackage(fixture, '@types/node')
  copyPackage(fixture, 'undici-types')
}

function compile (fixture, source) {
  writeFileSync(path.join(fixture, 'test.ts'), source)

  return spawnSync(process.execPath, typeScriptArguments, {
    cwd: fixture,
    encoding: 'utf8',
  })
}

describe('OpenTracing dependency', () => {
  let fixture

  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true })
  })

  it('vendors the OpenTracing 0.14.7 declarations unchanged', () => {
    const upstreamDirectory = path.dirname(require.resolve('opentracing/package.json'))
    const vendoredPackage = require(path.join(vendoredDirectory, 'package.json'))

    assert.strictEqual(vendoredPackage.name, 'opentracing')
    assert.strictEqual(vendoredPackage.version, '0.14.7')
    assert.strictEqual(vendoredPackage.types, 'lib/index.d.ts')

    const vendoredDeclarations = declarations(path.join(vendoredDirectory, 'lib'))
    const upstreamDeclarations = declarations(path.join(upstreamDirectory, 'lib'))
      .filter(file => !file.startsWith(`examples${path.sep}`) && !file.startsWith(`test${path.sep}`))

    assert.deepStrictEqual(vendoredDeclarations, upstreamDeclarations)

    for (const file of vendoredDeclarations) {
      const vendored = readFileSync(path.join(vendoredDirectory, 'lib', file), 'utf8')
      const upstream = readFileSync(path.join(upstreamDirectory, 'lib', file), 'utf8')

      assert.strictEqual(vendored.replace(/\n$/, ''), upstream.replace(/\n$/, ''), file)
    }
  })

  it('provides OpenTracing-compatible types without the package installed', () => {
    fixture = mkdtempSync(path.join(os.tmpdir(), 'dd-trace-opentracing-types-'))
    copyTracerPackage(fixture)

    const result = compile(fixture, `
      import tracer = require('dd-trace')
      import formats = require('dd-trace/ext/formats')

      const textMap: 'text_map' = formats.TEXT_MAP
      tracer.startSpan(textMap).finish()
    `)

    assert.strictEqual(existsSync(path.join(fixture, 'node_modules', 'opentracing')), false)
    assert.strictEqual(result.status, 0, result.stderr || result.stdout)
  })

  it('uses the same nominal types as a consumer-installed OpenTracing 0.14.7', () => {
    fixture = mkdtempSync(path.join(os.tmpdir(), 'dd-trace-opentracing-types-'))

    copyTracerPackage(fixture)
    copyPackage(fixture, 'opentracing')
    const result = compile(fixture, `
      import tracer = require('dd-trace')
      import * as opentracing from 'opentracing'

      opentracing.initGlobalTracer(tracer)
      const span: opentracing.Span = tracer.startSpan('operation')
      span.finish()
    `)

    assert.strictEqual(result.status, 0, result.stderr || result.stdout)
  })
})
