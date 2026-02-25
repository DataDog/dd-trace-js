#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const assert = require('assert')

const esbuild = require('esbuild')
const ddPlugin = require('../../esbuild') // dd-trace/esbuild

esbuild.build({
  minify: true,
  // keepNames: false, // the default
  entryPoints: ['basic-test.js'],
  bundle: true,
  outfile: 'minify-out.js',
  plugins: [ddPlugin],
  platform: 'node',
  target: ['node18'],
  external: [
    'knex',
  ],
}).then(() => {
  console.error('Expected build to throw an error, but it succeeded')
  process.exitCode = 1
}).catch((err) => {
  assert(
    err.message.includes('--minify without --keep-names'),
    'should throw error about minify without keepNames'
  )
  console.log('ok')
  process.exitCode = 0
}).finally(() => {
  fs.rmSync('./minify-out.js', { force: true })
})
