#!/usr/bin/env node
/* eslint-disable no-console */

import esbuild from 'esbuild'
import { spawnSync } from 'child_process'
import commonConfig from './build.esm.common-config.js'

// output => basic-test.mjs
await esbuild.build({
  ...commonConfig,
  outfile: undefined,
  format: undefined,
  outdir: './',
  outExtension: { '.js': '.mjs' }
})

const { status, stdout, stderr } = spawnSync('node', ['basic-test.mjs'])
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
