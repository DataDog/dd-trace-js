#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const esbuild = require('esbuild')
const ddPlugin = require('../../esbuild') // dd-trace/esbuild

const SCRIPT = './aws-sdk-v3-out.js'

esbuild.build({
  entryPoints: ['aws-sdk-v3.js'],
  bundle: true,
  outfile: SCRIPT,
  plugins: [ddPlugin],
  platform: 'node',
  target: ['node18'],
  external: [],
}).then(() => {
  // esbuild enables the `module` export condition and would pick `dist-es` for
  // every `@smithy/core` entry point except the hooked `dist-cjs` client file,
  // leaving two copies of the package in the bundle (see issue #10605).
  const bundle = fs.readFileSync(SCRIPT, 'utf8')
  const hookedFile = '@smithy/core/dist-cjs/submodules/client/index.js'

  assert.doesNotMatch(bundle, /@smithy\/core\/dist-es\//, 'bundle must not contain the dist-es copy of @smithy/core')
  assert.strictEqual(bundle.split(`// node_modules/${hookedFile}`).length - 1, 1, `${hookedFile} must be bundled once`)

  const { status, stdout, stderr } = spawnSync('node', [SCRIPT])
  if (stdout.length) {
    console.log(stdout.toString())
  }
  if (stderr.length) {
    console.error(stderr.toString())
  }
  if (status) {
    throw new Error('generated script failed to run')
  }
  console.log('ok')
}).catch((err) => {
  console.error(err)
  process.exitCode = 1
}).finally(() => {
  fs.rmSync(SCRIPT, { force: true })
})
