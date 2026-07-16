#!/usr/bin/env node

// Regression for https://github.com/DataDog/dd-trace-js/issues/8681.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import * as esbuild from 'esbuild'

const PACKAGE = 'dd-esbuild-cjs-fixture'
const installed = path.join('node_modules', PACKAGE)

// The plugin only wraps packages it knows are instrumented, and it reads this
// registry once when required. Copy the committed fixture into node_modules so
// it resolves as a real package, flag it as instrumented, then load the plugin.
await fs.rm(installed, { recursive: true, force: true })
await fs.cp('./instrumented-cjs-fixture', installed, { recursive: true })

const instrumentations = (globalThis[Symbol.for('_ddtrace_instrumentations')] ??= {})
instrumentations[PACKAGE] = [{ name: PACKAGE }]

const { default: ddPlugin } = await import('../../esbuild.js')

const ENTRY = './esm-minify-globals-entry.mjs'
const SCRIPT = './esm-minify-globals-out.mjs'

try {
  await fs.writeFile(ENTRY, `import fixture from '${PACKAGE}'\n\nprocess.stdout.write(JSON.stringify(fixture))\n`)

  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    outfile: SCRIPT,
    format: 'esm',
    minify: true,
    keepNames: true,
    platform: 'node',
    target: ['node18'],
    plugins: [ddPlugin],
  })

  const { status, stdout, stderr } = spawnSync('node', [SCRIPT])
  if (stderr.length) process.stderr.write(stderr)
  assert.equal(status, 0, 'minified ESM bundle should run without crashing')

  const result = JSON.parse(stdout.toString())
  assert.equal(result.rel, 'bundled-relative-ok')
  assert.match(result.filename, /\.mjs$/)
  assert.ok(result.dirname.length > 0)
  process.stdout.write('ok\n')
} finally {
  await fs.rm(SCRIPT, { force: true })
  await fs.rm(ENTRY, { force: true })
  await fs.rm(installed, { recursive: true, force: true })
}
