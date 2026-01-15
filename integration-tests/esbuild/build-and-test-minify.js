#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const assert = require('assert')

const esbuild = require('esbuild')
const ddPlugin = require('../../esbuild') // dd-trace/esbuild

const emitWarning = process.emitWarning
let didWarn = false
process.emitWarning = function (...args) {
  emitWarning(...args) // print something just so that we're not hiding any underlying issues
  if (args[1]?.code === 'DATADOG_0001') {
    didWarn = true
  }
}

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
    'knex'
  ]
}).then(() => {
  assert(didWarn, 'did properly warn user about using minify without keeping names')
  console.log('ok')
}).catch((err) => {
  console.error(err)
  process.exit(1)
}).finally(() => {
  process.emitWarning = emitWarning
  fs.rmSync('./minify-out.js', { force: true })
})
