#!/usr/bin/env node

// Regression for https://github.com/DataDog/dd-trace-js/issues/8681.

import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

import * as esbuild from 'esbuild'

import ddPlugin from '../../esbuild.js'

const SCRIPT = './esm-minify-out.mjs'

try {
  await esbuild.build({
    entryPoints: ['./esm-minify-entry.mjs'],
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
  assert.equal(stdout.toString(), 'ok')
  process.stdout.write('ok\n')
} finally {
  await fs.rm(SCRIPT, { force: true })
}
