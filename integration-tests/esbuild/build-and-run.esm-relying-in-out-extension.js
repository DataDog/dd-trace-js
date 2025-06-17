#!/usr/bin/env node
/* eslint-disable no-console */

const esbuild = require('esbuild')
const commonConfig = require('./build.esm.common-config')
const { spawnSync } = require('child_process')

// output => basic-test.mjs
esbuild.build({
  ...commonConfig,
  outfile: undefined,
  format: undefined,
  outdir: './',
  outExtension: { '.js': '.mjs' }
}).then(() => {
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
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
