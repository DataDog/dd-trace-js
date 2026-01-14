#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

process.env.DD_TRACE_DEBUG = 'true'

const fs = require('fs')
const assert = require('assert')

const esbuild = require('esbuild')
const ddPlugin = require('../../esbuild') // dd-trace/esbuild

const consoleWarn = console.warn
let didWarn = false
console.warn = function (message) {
  console.error(message) // print something just so that we're not hiding any underlying issues
  if (message.includes('--minify') && message.includes('--keep-names')) {
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
  console.warn = consoleWarn
  fs.rmSync('./minify-out.js', { force: true })
})
