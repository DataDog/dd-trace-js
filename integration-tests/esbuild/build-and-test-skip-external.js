#!/usr/bin/env node
const fs = require('fs')
const assert = require('assert')

const ddPlugin = require('../../esbuild') // dd-trace/esbuild
const esbuild = require('esbuild')

esbuild.build({
  entryPoints: ['skip-external.js'],
  bundle: true,
  outfile: 'skip-external-out.js',
  plugins: [ddPlugin],
  platform: 'node',
  target: ['node16'],
  external: [
    'knex'
  ]
}).then(() => {
  const output = fs.readFileSync('./skip-external-out.js').toString()
  // Note that esbuild converts 'foo' into "foo"
  assert(output.includes('require("knex")'), 'bundle should contain a require call to non-bundled knex')
  assert(!output.includes('require("axios")'), 'bundle should not contain a require call to bundled axios')
  console.log('ok') // eslint-disable-line no-console
  fs.rmSync('./skip-external-out.js')
}).catch((err) => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})
