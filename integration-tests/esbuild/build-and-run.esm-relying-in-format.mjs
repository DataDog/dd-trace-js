#!/usr/bin/env node
/* eslint-disable no-console */

import esbuild from 'esbuild'
import { spawnSync } from 'child_process'
import { renameSync } from 'fs'
import commonConfig from './build.esm.common-config.js'

await esbuild.build({
  ...commonConfig,
  outfile: 'out.js'
})

// to force being executed as module
renameSync('./out.js', './out.mjs')

const { status, stdout, stderr } = spawnSync('node', ['out.mjs'])
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
