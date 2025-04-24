#!/usr/bin/env node

import fs from 'fs/promises'

import * as esbuild from 'esbuild'
import assert from 'assert'

import ddPlugin from '../../esbuild.js'

try {
  await esbuild.build({
    entryPoints: ['./koa.mjs'],
    bundle: true,
    outfile: './outfile.js',
    minify: false,
    sourcemap: false,
    platform: 'node',
    target: 'es2022',
    plugins: [ddPlugin],
    external: [
      'graphql/language/visitor',
      'graphql/language/printer',
      'graphql/utilities'
    ]
  })

  // Verify instrumentation
  const data = await fs.readFile('./outfile.js', 'utf8')

  assert.match(data, /^ {8}package: "koa",$/m, 'Bundle should contain the koa instrumentation')
  assert.match(data, /^ {8}package: "@koa\/router",$/m, 'Bundle should contain the @koa/router instrumentation')

  console.log('ok') // eslint-disable-line no-console
} finally {
  await fs.rm('./outfile.js', { force: true })
}
