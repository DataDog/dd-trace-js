#!/usr/bin/env node
/* eslint-disable no-console */
const { spawnSync } = require('child_process')

const ddPlugin = require('../../esbuild') // dd-trace/esbuild
const esbuild = require('esbuild')

const SCRIPT = './aws-sdk-out.js'

esbuild.build({
  entryPoints: ['aws-sdk.js'],
  bundle: true,
  outfile: SCRIPT,
  plugins: [ddPlugin],
  platform: 'node',
  target: ['node16'],
  external: [ ]
}).then(() => {
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
  process.exit(1)
}).finally(() => {
  // fs.rmSync(SCRIPT)
})
