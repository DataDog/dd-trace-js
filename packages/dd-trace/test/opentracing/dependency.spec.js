'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { afterEach, describe, it } = require('mocha')

const root = path.resolve(__dirname, '../../../..')

describe('OpenTracing dependency', () => {
  let fixture

  afterEach(() => {
    if (fixture) rmSync(fixture, { recursive: true, force: true })
  })

  it('provides OpenTracing-compatible types without the package installed', () => {
    fixture = mkdtempSync(path.join(os.tmpdir(), 'dd-trace-opentracing-types-'))
    const packageDirectory = path.join(fixture, 'node_modules', 'dd-trace')

    mkdirSync(path.join(packageDirectory, 'ext'), { recursive: true })
    mkdirSync(path.join(packageDirectory, 'packages', 'dd-trace', 'src', 'opentracing'), { recursive: true })
    copyFileSync(path.join(root, 'index.d.ts'), path.join(packageDirectory, 'index.d.ts'))
    copyFileSync(path.join(root, 'ext', 'formats.d.ts'), path.join(packageDirectory, 'ext', 'formats.d.ts'))
    copyFileSync(
      path.join(root, 'packages', 'dd-trace', 'src', 'opentracing', 'types.d.ts'),
      path.join(packageDirectory, 'packages', 'dd-trace', 'src', 'opentracing', 'types.d.ts')
    )
    writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'dd-trace',
      types: 'index.d.ts',
    }))
    writeFileSync(path.join(fixture, 'test.ts'), `
      import tracer = require('dd-trace')
      import formats = require('dd-trace/ext/formats')
      import type { Tracer as OpenTracingTracer } from 'opentracing'

      const compatible: OpenTracingTracer = tracer
      const textMap: 'text_map' = formats.TEXT_MAP
      compatible.startSpan(textMap)
    `)

    assert.strictEqual(existsSync(path.join(fixture, 'node_modules', 'opentracing')), false)

    const result = spawnSync(process.execPath, [
      require.resolve('typescript/bin/tsc'),
      '--module', 'nodenext',
      '--moduleResolution', 'nodenext',
      '--noEmit',
      '--skipLibCheck',
      '--strict',
      '--target', 'es2020',
      'test.ts',
    ], {
      cwd: fixture,
      encoding: 'utf8',
    })

    assert.strictEqual(result.status, 0, result.stderr || result.stdout)
  })
})
