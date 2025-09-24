#!/usr/bin/env node
'use strict'

const ddPlugin = require('../../esbuild') // dd-trace/esbuild
const esbuild = require('esbuild')
const fs = require('fs')

const SCRIPT = __dirname + '/hono-out.mjs'

const entryPoint = __dirname + '/hono.js'

esbuild.build({
  entryPoints: [entryPoint],
  outfile: SCRIPT,
  minify: false,
  bundle: true,
  loader: { '.ts': 'ts' },
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  plugins: [ddPlugin],
  format: 'esm',
  external: []
}).then(() => {
  console.log('ok')
}).catch((err) => {
  console.error(err)
  process.exit(1)
}).finally(() => {
  // fs.rmSync(SCRIPT, { force: true })
})